# Receipt Categorizer Backend

Holds your OpenAI API key privately and turns raw scanned receipt text into
categorized line items (Food, Alcohol, Tax, Tip) using the OpenAI API.

## Deploy on Render (free tier works)

1. Put this folder in its own GitHub repo (or a folder within one).
2. Go to https://render.com → New → Web Service → connect your repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment:** Node
4. Under "Environment Variables," add:
   - `OPENAI_API_KEY` = your new OpenAI key (the one you generate AFTER revoking the leaked one)
5. Deploy. Render will give you a URL like `https://your-app-name.onrender.com`.
6. Test it's alive by visiting that URL in a browser — it should say
   "Receipt categorizer backend is running."

## Deploy on Vercel (alternative)

Vercel prefers serverless functions rather than a long-running Express app.
If you'd rather use Vercel, let me know and I'll restructure this as a
`/api/categorize.js` serverless function instead — the logic is the same,
just a different file layout.

## Using it from the web app

Once deployed, copy your Render URL and paste it into the `BACKEND_URL`
constant near the top of the `<script>` tag in `receipt-scanner.html`:

```js
const BACKEND_URL = "https://your-app-name.onrender.com/api/categorize";
```

That's it — the web app will send the scanned receipt text to your backend,
which calls OpenAI with your private key and returns the categorized items.

## Local testing (optional)

```bash
cp .env.example .env
# edit .env and paste your key
npm install
npm start
```

Then test with:

```bash
curl -X POST http://localhost:3000/api/categorize \
  -H "Content-Type: application/json" \
  -d '{"text": "Burger 12.00\nBeer 8.00\nTax 1.60\nTip 4.00\nTotal 25.60"}'
```

## Security notes

- Your API key lives only in Render's/Vercel's environment variable settings — never in code, never in the frontend, never committed to git.
- `.env` is for local testing only; make sure it's in `.gitignore` if you push this to GitHub (see below).
- This backend currently accepts requests from any origin (`cors()` with no restrictions) so your phone browser can reach it. If you want to lock it down to only your own web app's domain later, I can tighten that.
