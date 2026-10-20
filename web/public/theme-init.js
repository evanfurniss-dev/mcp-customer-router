// Keep the key and accepted values in sync with src/lib/theme.ts.
;(function () {
  var theme
  try {
    theme = localStorage.getItem('mcp-customer-router.theme')
  } catch {
    // The system preference also works when storage is blocked.
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
})()
