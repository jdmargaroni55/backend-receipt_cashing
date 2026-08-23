// server.js
//
// Small backend that keeps your OpenAI API key private on the server.
// The phone/browser app sends it raw OCR text; this server asks OpenAI
// to split it into line items (Food, Alcohol, Tax, Tip) and sends back
// clean JSON.
//
// Your API key lives ONLY in an environment variable on the host
// (Render/Vercel/etc.) — it is never sent to or visible from the browser.

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());               // allow the web app (a different origin) to call this
app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // set this in your host's dashboard, never in code
});

const SYSTEM_PROMPT = `You are a receipt-parsing assistant.
You will be given raw, possibly messy OCR text scanned from a restaurant or store receipt.
Extract every purchasable line item and every charge (tax, tip/gratuity).

Return ONLY a JSON object with this exact shape, no other text:
{
  "items": [
    { "desc": "string, the item name as best you can tell", "price": 12.99, "category": "Food" | "Alcohol" | "Tax" | "Tip" }
  ]
}

The "price" field MUST be a plain JSON number (e.g. 12.99), never a string, and never include a currency symbol like "$".

Rules:
- "Alcohol" = beer, wine, liquor, cocktails, and any other alcoholic beverages.
- "Food" = all other food and non-alcoholic drinks.
- "Tax" = sales tax / VAT / GST lines.
- "Tip" = tip, gratuity, or service charge lines.
- Do NOT include subtotal, total, balance due, change, or payment method lines (card numbers, "visa", "cash", etc.) as items.
- If a price is ambiguous or missing, do your best guess but never invent items that aren't implied by the text.
- Prices should be positive numbers with two decimals, no currency symbols.`;

app.post("/api/categorize", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing 'text' field in request body." });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    });

    const raw = completion.choices[0].message.content;
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed.items)) {
      throw new Error("Model did not return an items array.");
    }

    res.json(parsed);
  } catch (err) {
    console.error("Categorize error:", err);
    res.status(500).json({ error: "Failed to categorize receipt.", detail: String(err.message || err) });
  }
});

app.get("/", (req, res) => {
  res.send("Receipt categorizer backend is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
