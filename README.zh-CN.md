# 客户相册（自建版 Pixieset）

[English → README.md](README.md)

给客户选片 → 精修 → 交付下载，一个链接搞定。

## 功能

**你（后台 `/admin`）**
- 新建相册：标题、日期、访问密码、可选精修张数
- 拖拽上传：「原片（调色后）」和「精修」两组，同名文件自动替换
- 看客户选了哪些 + 每张的修图备注
- 一键复制已选文件名 → 粘贴进 Lightroom 筛选器（文本 → 文件名 → 包含），一次筛出所有已选
- 下载 CSV、打包下载已选原图、设封面、解锁让客户重选
- 文件夹分组（可隐藏）、封面焦点和排列样式
- 照片排序：按拍摄时间（EXIF，含毫秒）、按文件名、手动拖动
- 访问统计：每天访问次数、访客人数、最常被放大的照片、下载记录、手机 / 电脑占比（不记录 IP，管理员自己的浏览不计入）

**客户（`/g/xxxx` 分享链接）**
- 全屏封面 + 等高行瀑布流，手机、电脑都好看
- 点 ♡ 选片，有张数上限，大图里可以写修图备注，选完「提交选片」锁定
- 精修 / 全部照片 / 我的选片 三个分组
- 单张下载原图，或打包 ZIP 下载（精修、全部、已选）—— 下载的是你上传的原文件，画质不压缩

## 本地运行

需要 Node.js 22.13 以上（推荐 24）。

```bash
npm install
ADMIN_PASSWORD=换成你的密码 npm start
```

打开 http://localhost:3000/admin

照片和数据库都保存在 `data/` 文件夹，**备份这个文件夹就等于备份全部**。

## 放到网上给客户用

### 方案 A：便宜 VPS（推荐，约 RM20–40 / 月）

Hetzner、Vultr、DigitalOcean、腾讯云轻量等任一台 Ubuntu 服务器（1 核 2G 就够）。
一套 prewedding 原片 + 精修大约 5–15 GB，硬盘按相册数量选，不够可以加云硬盘。

```bash
# 服务器上
curl -fsSL https://get.docker.com | sh
git clone <你的仓库> photo-gallery && cd photo-gallery   # 或用 scp 上传文件夹
docker build -t gallery .
docker run -d --name gallery --restart always -p 3000:3000 \
  -e ADMIN_PASSWORD=换成你的密码 -v /srv/gallery:/data gallery
```

再装 Caddy 自动配 HTTPS（把域名 A 记录指向服务器 IP）：

```bash
apt install -y caddy
echo 'photos.你的域名.com {
  reverse_proxy localhost:3000
  request_body { max_size 300MB }
}' > /etc/caddy/Caddyfile && systemctl reload caddy
```

### 方案 B：用自己的 Mac + Cloudflare Tunnel（免费）

Mac 开着就能访问，不用买服务器，缺点是 Mac 要一直开机、客户下载速度取决于你家宽带上传速度。

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

它会给你一个 `https://xxxx.trycloudflare.com` 链接（每次重启会变；绑定自己域名可以固定，见 Cloudflare 文档）。

## 小贴士

- 导出原片时文件名保持相机原名（如 `DSC_1234.jpg`），这样客户选完后复制文件名回 Lightroom 最方便
- 精修图建议用**和原片相同的文件名**导出，客户一看就知道对应哪张
- 预览图会自动生成（网页显示用 2400px），客户下载拿到的是你上传的原文件
- 想换管理员密码：改 `ADMIN_PASSWORD` 重启即可

## 授权协议

[AGPL-3.0](LICENSE)。可以免费使用、修改、自己架设；如果把**修改过的版本**做成服务给别人用，必须用同样的协议公开修改后的源代码。
