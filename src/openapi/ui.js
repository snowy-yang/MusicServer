// 文档页面 —— Swagger UI（/docs）与 ReDoc（/redoc），静态 HTML + CDN 资源

const SWAGGER_CDN = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui.css'
const SWAGGER_BUNDLE_CDN = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js'
const REDOC_CDN = 'https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js'

const htmlShell = (title, body) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${body.head}
</head>
<body>
  ${body.content}
</body>
</html>`

export const swaggerHtml = ({ title, specUrl = '/openapi.json' }) => htmlShell(title, {
  head: `
  <link rel="stylesheet" href="${SWAGGER_CDN}">
  <style>body { margin: 0; }</style>`,
  content: `
  <div id="swagger-ui"></div>
  <script src="${SWAGGER_BUNDLE_CDN}" crossorigin></script>
  <script>
    window.onload = () => window.ui = SwaggerUIBundle({
      url: '${specUrl}',
      dom_id: '#swagger-ui',
      docExpansion: 'none',
      persistAuthorization: true,
      tryItOutEnabled: true,
    })
  </script>`,
})

export const redocHtml = ({ title, specUrl = '/openapi.json' }) => htmlShell(`${title} (ReDoc)`, {
  head: `
  <style>body { margin: 0; padding: 0; }</style>`,
  content: `
  <redoc spec-url="${specUrl}" hide-download-button="true"></redoc>
  <script src="${REDOC_CDN}"></script>`,
})
