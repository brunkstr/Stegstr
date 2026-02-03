# Deploying the Stegstr website on cPanel

## 1. Put files in the document root

Your site must be served so that **the contents** of this folder are at the **document root** (usually `public_html`).

- **Correct:** `public_html/index.html`, `public_html/config/relay.json`, `public_html/css/`, etc.
- **Wrong:** `public_html/stegstr-website/index.html` — then the relay config would be at `/stegstr-website/config/relay.json`, and the app would not find it.

**If you unzipped and got a folder named `stegstr-website`:**  
Move everything *inside* that folder into `public_html` (so `public_html` contains `index.html`, `config/`, `css/`, etc.), or upload the zip and choose “Extract to document root” so the archive contents go directly into `public_html`.

## 2. Check that the relay config URL works

Open in a browser (use your real domain):

- `https://yourdomain.com/config/relay.json`  
  You should see: `{"proxyUrl":"wss://relay.stegstr.com"}` (or your proxy URL).

If that URL gives 404 or doesn’t open:

1. Confirm you have `public_html/config/relay.json` (and that you didn’t leave files inside a `stegstr-website` subfolder).
2. If your host blocks or blocks serving `.json` files, the app will automatically try:  
   `https://yourdomain.com/config/relay.php`  
   So ensure `config/relay.php` is also in `public_html/config/`. Then either fix serving for `relay.json` (e.g. via `.htaccess`) or rely on `relay.php`.

## 3. Optional: .htaccess for relay.json

The folder includes `config/.htaccess` so Apache serves `relay.json` with the correct `Content-Type`. If your host ignores it or still blocks `.json`, use `relay.php` as above.

## 4. Relay proxy (separate from the website)

The **website** only serves the config file. The **relay proxy** (e.g. `wss://relay.stegstr.com`) must be run and deployed separately (see `relay-proxy/README.md`). The URL in `config/relay.json` (or `relay.php`) must point to where that proxy is actually running.
