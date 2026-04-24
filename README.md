# facebook-phone-checker-web

批量检测手机号是否命中 Facebook 账号恢复流程。

## 本地运行

```bash
npm install
npx playwright install chromium
npm start
```

打开：

```bash
http://localhost:3000
```

## Railway 部署

推荐设置：

- Start Command: `npm start`
- Node version: 20+

本项目优先使用 Docker 部署，并要求 Docker 镜像里的 Playwright 版本与 `package.json` 保持一致。

当前固定版本：

- Playwright npm: `1.59.1`
- Docker image: `mcr.microsoft.com/playwright:v1.59.1-noble`

如果后续升级 Playwright，必须同时升级这两个版本，避免浏览器可执行文件路径不匹配。

## 接口

### POST /api/check

body:

```json
{
  "phones": "8613812345678\n8615012345678",
  "delayMs": 2000
}
```
