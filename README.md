
# SRW Middleware

This middleware scrapes job data and provides a JSON API endpoint for your WordPress site.

## Setup on Render
1. Upload this repo to GitHub.
2. Connect GitHub repo to Render.
3. Set Environment Variables:
   - OPENAI_API_KEY
   - PORT
   - SITES_CONFIG
   - MIDDLEWARE_SECRET
4. Build Command: npm install
5. Start Command: node index.js
6. Deploy and get URL for middleware.

## Usage
Use the middleware URL in your WordPress plugin settings.
