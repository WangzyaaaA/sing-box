# sing-box 流量审计部署与使用

本文介绍如何为 233boy/sing-box 管理脚本部署可选的流量审计服务，以及如何访问
Web 仪表盘、筛选和导出数据、调整保留策略、备份恢复和排查故障。

> 流量审计会记录来源 IP、配置文件、可识别的 UUID/用户、目标地址、端口、协议、路由和流量等信息。
> 部署前请确认符合所在地法律、服务条款和隐私要求，并只向授权人员开放页面。

## 1. 功能概览

流量审计以独立服务运行，不会把 Web 逻辑放进 sing-box 主进程。

```text
客户端流量
    │
    ▼
sing-box ── 本机 Clash API ──► sing-box-audit
                                    │
                     ┌──────────────┴──────────────┐
                     ▼                             ▼
          SQLite 持久化数据库                 Web/API 服务
      /var/lib/sing-box-audit/            127.0.0.1:9091
                     │                             │
                     └──────────────┬──────────────┘
                                    ▼
                         展示、筛选、CSV/JSON 导出
```

默认设置：

| 项目 | 默认值 |
| --- | --- |
| 服务名 | `sing-box-audit` |
| Web 监听 | `127.0.0.1:9091` |
| 采集间隔 | 1 秒 |
| 数据保留 | 90 天 |
| 数据库 | `/var/lib/sing-box-audit/audit.db` |
| 服务配置 | `/etc/sing-box/audit/config.json` |
| 程序文件 | `/etc/sing-box/sh/src/audit/` |
| 鉴权 | Bearer 访问令牌 |

审计服务通过 sing-box Clash API 的 `/connections` 接口读取总流量和活动连接。
总流量按核心累计计数增量持久化；每条活动连接也按采集周期计算上传、下载增量，再按
来源 IP、配置身份和分钟聚合到独立的用量采样表。分钟聚合可避免长期运行时按连接、按秒
产生过量数据库记录。因此，跨越时间范围的长连接只会把所选分钟内观察到的增量计入
IP / 配置汇总；自定义起止时间在 IP / 配置用量中按覆盖到的整分钟统计。

本项目生成的每个代理配置文件对应一个带同名 tag 的入站。审计服务会优先使用 Clash API
返回的用户字段；核心未返回用户时，则通过入站 tag 只读匹配 `/etc/sing-box/conf/*.json`。
配置中只有一个 UUID 用户时，页面显示该 UUID；密码类协议不会把密码复制到审计数据库，
而是使用配置文件名作为身份。手工在同一个入站中配置多个用户、且核心没有返回用户字段时，
只能统计到该配置文件，无法进一步区分其中的用户。

核心重启导致总计数回退时，服务会自动建立新基线，不会清空既有历史数据。连接明细每秒
采样，持续时间短于采样周期的极短连接可能不出现在明细和 IP / 配置汇总中，但其字节数
仍会进入总流量统计。

从旧版审计服务升级时，原有总流量采样、连接记录、配置和数据库都会保留，数据库结构会
在服务启动时自动迁移。旧连接只保存累计值，无法反推出过去每一分钟属于哪个 IP/配置的
增量，因此 IP / 配置区间用量从升级后首次成功采集开始累计，不会伪造历史归属数据。

## 2. 部署前准备

### 2.1 支持环境

- Ubuntu、Debian、CentOS、SUSE 或 Alpine Linux。
- systemd 或 OpenRC。
- amd64 或 arm64。
- 已通过本项目安装 sing-box，或准备执行全新安装。
- root 权限。
- sing-box 核心需要包含 Clash API 支持；启用时会自动执行配置检查。

Python 3 和标准库 `sqlite3` 是审计服务唯一的新增运行时依赖。首次执行
`sing-box audit enable` 时，如果系统缺少 Python 3，脚本会使用当前发行版的包管理器
自动安装；不启用审计时不会安装该依赖。

可先手动检查：

```bash
python3 --version
python3 -c 'import sqlite3; print(sqlite3.sqlite_version)'
```

### 2.2 重要影响

首次启用会：

1. 检查并按需安装 Python 3。
2. 创建 `/etc/sing-box/audit` 和 `/var/lib/sing-box-audit`。
3. 复用现有 sing-box Clash API；若不存在，则在 `config.json` 中创建只监听本机的
   Clash API 和随机密钥。
4. 检查 sing-box 配置。
5. 安装并启用 `sing-box-audit` systemd/OpenRC 服务。
6. 若新建了 Clash API，重启一次 sing-box。

启用过程不会读取数据包内容，也不会修改防火墙或内核网络设置。

## 3. 安装或更新脚本

根据部署场景选择下面一种方式。

### 3.1 全新安装

在受支持的 Linux 服务器上以 root 身份执行一键安装：

```bash
bash <(wget -qO- https://raw.githubusercontent.com/WangzyaaaA/sing-box/main/install.sh)
```

无需下载整个仓库。`install.sh` 会从本仓库的 GitHub Release 下载发布包。

如需审查源码或进行本地修改，也可以获取完整仓库后安装：

```bash
git clone https://github.com/WangzyaaaA/sing-box.git
cd sing-box
bash install.sh --local-install
```

`install.sh` 会安装 sing-box 主服务并生成默认代理配置。请注意，这不是只安装审计服务，
不要在已有 sing-box 安装上重复执行；已有安装请使用下一节的方法。

安装完成后启用审计：

```bash
sing-box audit enable
```

### 3.2 已安装服务器：迁移到本仓库

如果服务器原来安装的是 `233boy/sing-box`，它的 `sing-box update.sh` 仍指向原作者仓库。
执行下面的一次性迁移，把管理脚本更新源切换到本仓库：

```bash
bash <(wget -qO- https://raw.githubusercontent.com/WangzyaaaA/sing-box/main/install.sh) --script-update
sing-box audit enable
```

`--script-update` 只覆盖 `/etc/sing-box/sh` 下的管理脚本，不重装 sing-box，不修改
`/etc/sing-box/conf` 中的代理配置，也不会删除 `/etc/sing-box/audit` 或
`/var/lib/sing-box-audit` 中的配置和数据库。迁移后再执行 `sing-box update.sh` 时，
脚本会从本仓库获取更新。

### 3.3 已安装服务器：部署当前本地源码

如需在正式发布前测试当前工作区代码，把仓库复制或克隆到服务器，然后执行：

```bash
cd /path/to/sing-box
cp -a src/. /etc/sing-box/sh/src/
cp -f sing-box.sh /etc/sing-box/sh/sing-box.sh
chmod +x /etc/sing-box/sh/sing-box.sh
sing-box audit enable
```

原来的 `/usr/local/bin/sing-box` 和 `/usr/local/bin/sb` 会继续指向
`/etc/sing-box/sh/sing-box.sh`，无需重新建立链接。

如果服务器上的脚本包含本地定制，请先备份 `/etc/sing-box/sh`，再决定是否覆盖。

## 4. 首次启用

### 4.1 默认启用

推荐使用只监听本机的默认设置：

```bash
sing-box audit enable
```

成功后会显示页面地址和随机访问令牌，例如：

```text
审计页面: http://127.0.0.1:9091/
访问令牌: <随机令牌>
```

令牌不会写入页面 URL。以后可重新查看：

```bash
sing-box audit url
sing-box audit token
sing-box audit status
```

### 4.2 指定监听地址和端口

首次启用时可指定 IPv4 地址和端口：

```bash
sing-box audit enable 127.0.0.1 9191
```

如确实需要监听全部网卡：

```bash
sing-box audit enable 0.0.0.0 9091
```

`0.0.0.0` 会让所有可到达服务器端口的主机看到登录页。即使 API 仍有令牌保护，
也应同时配置防火墙来源限制和 HTTPS 反向代理。更推荐保持默认监听并使用 SSH 转发。

### 4.3 验证部署

```bash
sing-box audit status
sing-box status
```

systemd：

```bash
systemctl status sing-box-audit --no-pager
systemctl is-enabled sing-box-audit
ss -lntp | grep 9091
```

OpenRC：

```bash
rc-service sing-box-audit status
rc-update show | grep sing-box-audit
ss -lntp | grep 9091
```

本机健康检查不需要访问令牌：

```bash
curl http://127.0.0.1:9091/api/health
```

预期返回类似：

```json
{"ok":true,"service":"sing-box-audit","version":"1.1.0","auth_required":true}
```

## 5. 访问 Web 仪表盘

### 5.1 SSH 端口转发（推荐）

在自己的电脑上运行：

```bash
ssh -L 9091:127.0.0.1:9091 root@服务器IP
```

保持 SSH 会话连接，然后打开：

```text
http://127.0.0.1:9091/
```

输入服务器上 `sing-box audit token` 显示的访问令牌。令牌只保存在当前浏览器标签页的
`sessionStorage` 中，关闭标签页后需要重新输入。

如果审计服务使用了其他端口，请同步修改 SSH 命令两侧端口。例如服务监听 9191：

```bash
ssh -L 9191:127.0.0.1:9191 root@服务器IP
```

### 5.2 HTTPS 反向代理

如需长期从公网或内网访问，保持审计服务监听 `127.0.0.1`，由现有 Nginx、Caddy 或
其他网关提供 HTTPS。以下是 Nginx 基本示例：

```nginx
server {
    listen 443 ssl;
    server_name audit.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/private.key;

    location / {
        proxy_pass http://127.0.0.1:9091;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

还应至少采用一种额外保护：

- 只允许管理网段或 VPN 网段访问。
- 在反向代理增加 Basic Auth、单点登录或访问策略。
- 在云安全组或主机防火墙限制 443 的来源。
- 不要把访问令牌写进 URL、网页源码、公开日志或聊天记录。

## 6. 仪表盘使用

登录后页面提供：

- 总流量、上传、下载和活动连接数。
- 当前上传、下载和总速率。
- 1 小时、6 小时、24 小时、7 天、30 天、全部历史或自定义起止时间的流量趋势。
- 热门目标地址。
- 按来源 IP、配置文件和 UUID/用户汇总所选时间段的上传、下载、合计、连接数及首次/最后流量时间。
- 连接开始时间、来源、目标、用户/入站、协议、路由、上传、下载和状态。
- 按 IP、配置文件、UUID/用户、关键词、协议和连接状态筛选。
- 分页浏览。
- 按当前时间范围和筛选条件导出 IP / 配置汇总或连接明细 CSV/JSON。

页面每 5 秒刷新一次；采集服务默认每 1 秒读取一次 sing-box 状态。页面关闭不会停止采集，
只要 `sing-box-audit` 服务运行，数据就会继续写入 SQLite。

## 7. 命令行使用

查看完整帮助：

```bash
sing-box audit help
```

### 7.1 服务管理

```bash
sing-box audit start
sing-box audit stop
sing-box audit restart
sing-box audit status
```

也可使用原管理命令：

```bash
sing-box start audit
sing-box stop audit
sing-box restart audit
```

### 7.2 修改配置

修改监听地址：

```bash
sing-box audit set listen 127.0.0.1
```

修改 Web 端口：

```bash
sing-box audit set port 9191
```

修改数据保留天数，允许范围为 1–3650：

```bash
sing-box audit set retention 30
```

修改采集间隔，允许范围为 1–60 秒：

```bash
sing-box audit set interval 5
```

重新生成访问令牌：

```bash
sing-box audit set token reset
```

设置自定义访问令牌，至少 16 个字符：

```bash
sing-box audit set token 'replace-with-a-long-random-token'
```

修改成功后审计服务会自动重启。如果新配置无法启动，脚本会恢复原配置。

### 7.3 命令行导出

语法：

```text
sing-box audit export [csv|json] [1h|6h|24h|7d|30d|all] [输出文件]
```

示例：

```bash
# 导出最近 24 小时，自动在当前目录生成带时间戳的文件
sing-box audit export csv 24h

# 导出最近 7 天到指定文件
sing-box audit export csv 7d /root/sing-box-audit-7d.csv

# 导出全部保留数据为 JSON
sing-box audit export json all /root/sing-box-audit-all.json
```

CSV/JSON 导出包含连接 ID、开始/结束时间、最后采集时间、连接状态、网络类型、入站、
配置文件、来源和目标、用户、协议、进程、出站链、规则以及上传/下载字节数。时间字段
使用 Unix 时间戳；Web 页面会按浏览器本地时区显示。

如需导出按来源 IP、配置文件和 UUID/用户聚合后的区间用量，使用 `report`：

```text
sing-box audit report [csv|json] [1h|6h|24h|7d|30d|all] [输出文件]
```

```bash
# 导出最近 7 天每个 IP / 配置身份的汇总用量
sing-box audit report csv 7d

# 导出全部保留用量为 JSON
sing-box audit report json all /root/sing-box-audit-usage.json
```

汇总导出包含来源 IP、配置文件、UUID/用户、首次和最后流量时间、连接数以及上传、下载、
总字节数。Web 页面 IP / 配置面板中的 CSV/JSON 按钮导出相同数据，并支持自定义起止时间；
页面顶部的“导出连接 CSV”继续导出原有连接明细。

导出采用临时文件流式传输，避免历史记录较多时把完整导出一次性加载进服务内存。

### 7.4 手动清理历史数据

删除指定天数以前的数据：

```bash
sing-box audit purge 30
```

上面的命令表示删除 30 天以前的总流量采样、连接增量采样和已结束连接。活动连接不会被删除。

服务本身还会根据 `retention_days` 每小时自动检查并清理过期数据。

## 8. 持久化、备份与恢复

### 8.1 持久化文件

默认数据库：

```text
/var/lib/sing-box-audit/audit.db
```

SQLite 运行期间还可能出现：

```text
/var/lib/sing-box-audit/audit.db-wal
/var/lib/sing-box-audit/audit.db-shm
```

服务配置：

```text
/etc/sing-box/audit/config.json
```

配置文件包含 Web 访问令牌和 sing-box API 密钥，默认权限为 `0600`；数据库默认权限为
`0640`，目录权限为 `0750`。不要把这些文件提交到 Git 或发送给无关人员。

### 8.2 安全备份

最简单可靠的方式是在短暂停止审计服务后备份整个数据目录：

```bash
sing-box audit stop
tar -C /var/lib -czf /root/sing-box-audit-backup-$(date +%Y%m%d).tar.gz sing-box-audit
cp -a /etc/sing-box/audit/config.json /root/sing-box-audit-config-$(date +%Y%m%d).json
sing-box audit start
```

备份文件包含敏感审计数据和令牌，应使用受限权限保存：

```bash
chmod 600 /root/sing-box-audit-backup-*.tar.gz
chmod 600 /root/sing-box-audit-config-*.json
```

### 8.3 恢复数据库

目标服务器应先完成脚本更新并执行一次 `sing-box audit enable`，让服务和目录结构创建完成。
然后恢复数据库：

```bash
sing-box audit stop
mv /var/lib/sing-box-audit /var/lib/sing-box-audit.before-restore
tar -C /var/lib -xzf /root/sing-box-audit-backup-YYYYMMDD.tar.gz
chown -R root:root /var/lib/sing-box-audit
chmod 750 /var/lib/sing-box-audit
chmod 640 /var/lib/sing-box-audit/audit.db*
sing-box audit start
sing-box audit status
```

确认恢复成功后再删除 `/var/lib/sing-box-audit.before-restore`。如果需要恢复原访问令牌，
可在停止服务后恢复配置文件并保持 `0600` 权限；否则保留目标服务器新生成的配置和令牌即可。

### 8.4 更新和重装的区别

- `sing-box update.sh`：更新脚本，保留审计配置和数据库。
- `sing-box update core`：更新并重启核心；审计服务识别计数器回退并继续累计。
- `sing-box audit disable`：停止并取消开机启动，但保留配置和数据库。
- `sing-box audit uninstall`：确认后删除审计服务、配置和全部数据库。
- `sing-box reinstall`：执行完整卸载再安装，会删除审计数据；运行前必须先备份。

## 9. API 调试

除健康检查外，审计 API 都需要 Bearer 令牌。调试时可从 root-only 配置文件读取令牌：

```bash
AUDIT_TOKEN=$(jq -r '.web_token' /etc/sing-box/audit/config.json)
curl -H "Authorization: Bearer $AUDIT_TOKEN" \
    'http://127.0.0.1:9091/api/summary?range=24h'
unset AUDIT_TOKEN
```

常用只读接口：

| 接口 | 用途 |
| --- | --- |
| `/api/health` | 服务健康和版本，不需要令牌 |
| `/api/summary?range=24h` | 汇总、速率、连接数和采集状态 |
| `/api/timeseries?range=24h` | 流量趋势 |
| `/api/top-destinations?range=24h` | 热门目标 |
| `/api/client-usage?range=24h&page=1&limit=50` | 按 IP、配置文件和 UUID/用户聚合的区间用量 |
| `/api/connections?range=24h&page=1&limit=50` | 连接记录 |
| `/api/export?format=csv&range=24h` | 导出连接记录 |
| `/api/usage-export?format=csv&range=24h` | 导出 IP / 配置汇总用量 |

`range` 支持 `1h`、`6h`、`24h`、`7d`、`30d` 和 `all`。
所有带时间范围的接口也支持同时传入 `start` 和 `end`，值可以是 Unix 秒级时间戳或
ISO 8601 时间；两者必须同时出现，且 `start` 不得晚于 `end`。例如：

```bash
curl -H "Authorization: Bearer $AUDIT_TOKEN" \
    'http://127.0.0.1:9091/api/client-usage?start=2026-08-01T00:00:00Z&end=2026-08-02T00:00:00Z'
```

## 10. 日志与故障排查

### 10.1 服务无法启动

systemd：

```bash
systemctl status sing-box-audit --no-pager
journalctl -u sing-box-audit -n 100 --no-pager
```

OpenRC：

```bash
rc-service sing-box-audit status
tail -n 100 /var/log/sing-box/audit-error.log
```

验证审计配置：

```bash
python3 /etc/sing-box/sh/src/audit/server.py \
    --config /etc/sing-box/audit/config.json --check
```

检查 Python SQLite：

```bash
python3 -c 'import sqlite3; print(sqlite3.sqlite_version)'
```

### 10.2 页面打不开

```bash
sing-box audit status
ss -lntp | grep 9091
curl http://127.0.0.1:9091/api/health
```

- 本机健康检查成功、远程浏览器失败：检查 SSH 转发、反向代理、防火墙和安全组。
- 使用 SSH 转发时，浏览器应访问本机 `127.0.0.1`，不是服务器公网 IP。
- 修改过端口时，确认 SSH 转发、反向代理和访问 URL 使用相同端口。

### 10.3 页面提示令牌无效或返回 401

```bash
sing-box audit token
```

重新输入完整令牌。令牌区分大小写，不能包含终端颜色控制字符。如果刚执行过
`sing-box audit set token reset`，旧标签页中的令牌立即失效，关闭页面并重新登录。

### 10.4 前端正常但数据采集异常

```bash
sing-box audit status
sing-box status
journalctl -u sing-box -n 100 --no-pager
```

查看 sing-box Clash API 配置：

```bash
jq '.experimental.clash_api' /etc/sing-box/config.json
```

检查完整 sing-box 配置：

```bash
sing-box check -c /etc/sing-box/config.json -C /etc/sing-box/conf
```

常见原因：

- sing-box 主服务未运行。
- Clash API 监听地址或密钥被手动修改，但审计配置没有同步。
- 端口被其他程序占用。
- 当前 sing-box 核心未包含 Clash API 支持。

如手动改过核心 API，建议先备份审计数据库，再执行
`sing-box audit uninstall -y` 和 `sing-box audit enable` 重新生成一致的配置。

### 10.5 流量总计与连接明细合计不一致

这是可能出现的正常现象：

- 总流量来自 sing-box 核心累计计数，包含采集期间的全部字节。
- IP / 配置用量与连接明细来自每秒活动连接采样，极短连接可能在两次采样之间完成。
- IP / 配置用量按每次采集之间的连接字节增量归属时间，长连接不会把时间段外的累计值算入。
- 无法识别来源 IP 或配置身份的流量仍会进入总流量，但只能在汇总表中显示为未知或未识别。

做整机容量统计时以页面总流量和趋势为准；调查具体 IP、配置或 UUID 时使用 IP / 配置
用量及其汇总导出；调查单条连接时使用连接明细与连接导出。

### 10.6 数据库持续增长

```bash
du -h /var/lib/sing-box-audit/audit.db*
sing-box audit set retention 30
sing-box audit purge 30
```

SQLite 删除旧行后文件尺寸不一定立即缩小，但已删除空间会被后续记录复用。不要在服务
运行时直接删除 `audit.db-wal` 或 `audit.db-shm`。

## 11. 禁用与卸载

停止采集并取消开机启动，但保留历史数据：

```bash
sing-box audit disable
```

重新启用：

```bash
sing-box audit enable
```

彻底卸载并删除配置、令牌和全部历史数据：

```bash
sing-box audit uninstall
```

非交互式确认：

```bash
sing-box audit uninstall -y
```

彻底卸载不可撤销。需要保留审计记录时，请先按照“备份与恢复”一节备份数据库。

## 12. 参考资料

- [sing-box 官方 Clash API 配置](https://sing-box.sagernet.org/configuration/experimental/clash-api/)
- [sing-box 官方配置与检查命令](https://sing-box.sagernet.org/configuration/)
