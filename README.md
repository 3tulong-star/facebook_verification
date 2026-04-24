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

首次构建需要安装 Playwright Chromium。可在 Railway 的构建阶段使用：

```bash
npx playwright install chromium
```

如果需要，也可以改成 Docker 部署以获得更稳定的浏览器环境。

## 接口

### POST /api/check

body:

```json
{
  "phones": "8613812345678\n8615012345678",
  "delayMs": 2000
}
```
