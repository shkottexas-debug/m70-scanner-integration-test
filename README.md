# M70 Scanner — integration test only

Изолированная тестовая публикация сканера М70 из коммита
`d9da62a7b5c9baa09380bafff37a85040ce0115b` PR #1.

- Не содержит QR-токенов, приватных ключей или Apps Script credentials.
- Прямое открытие страницы работает только в безопасном тестовом режиме.
- Авторизованный check-in возможен только через отдельный тестовый Apps Script web app.
- Не использовать с производственной таблицей или реальными билетами.

Тестовый `Registrar.html` должен открывать:

`https://shkottexas-debug.github.io/m70-scanner-integration-test/`
