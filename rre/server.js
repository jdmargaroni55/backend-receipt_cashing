// server.js
//
// Small backend that keeps your Gemini API key private on the server.
// The phone/browser app sends it raw OCR text; this server asks Gemini
// to split it into line items (Food, Alcohol, Tax, Tip) and sends back
// clean JSON.
//
// Your API key lives ONLY in an environment variable on the host
// (Render/Vercel/etc.) — it is never sent to or visible from the browser.

import express from "express";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";

const app = express();
app.use(cors());               // allow the web app (a different origin) to call this
app.use(express.json({ limit: "1mb" }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY, // set this in your host's dashboard, never in code
});

const SYSTEM_PROMPT = `You are a receipt-parsing assistant.
You will be given raw, possibly messy OCR text scanned from a restaurant or store receipt.
Extract every purchasable line item and every charge (tax, tip/gratuity).

Rules:
- "Alcohol" = beer, wine, liquor, cocktails, and any other alcoholic beverages (recognize actual drink/brand names, not just the literal word "alcohol").
- "Food" = all other food and non-alcoholic drinks (recognize actual dish/drink names, not just the literal word "food").
- "Tax" = sales tax / VAT / GST lines.
- "Tip" = tip, gratuity, or service charge lines.
- Do NOT include subtotal, total, balance due, change, or payment method lines (card numbers, "visa", "cash", etc.) as items.
- If a price is ambiguous or missing, do your best guess but never invent items that aren't implied by the text.
- Prices must be plain numbers (e.g. 12.99), never strings, never with a currency symbol.`;

// Gemini's structured-output schema — this forces the model to return
// exactly this shape, so we don't have to hope it follows instructions.
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          desc: { type: Type.STRING },
          price: { type: Type.NUMBER },
          category: {
            type: Type.STRING,
            enum: ["Food", "Alcohol", "Tax", "Tip"],
          },
        },
        required: ["desc", "price", "category"],
      },
    },
  },
  required: ["items"],
};

app.post("/api/categorize", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing 'text' field in request body." });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: `${SYSTEM_PROMPT}\n\nReceipt text:\n${text}`,
      config: {
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0,
      },
    });

    const raw = response.text;
    console.log("Raw Gemini response:", raw);
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
