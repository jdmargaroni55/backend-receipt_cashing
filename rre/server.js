// ===========================================================================
// server.js
//
// This is a small web server. Its whole job is:
//   1. Receive a receipt photo from the phone/browser app.
//   2. Send that photo to Google's Gemini AI, along with instructions
//      asking it to read the receipt and sort the charges into categories.
//   3. Send Gemini's answer back to the phone/browser app.
//
// The IMPORTANT reason this server exists at all: it's the only place that
// holds the secret Gemini API key. Browsers can't keep secrets (anyone can
// view the page's source code), so the key must live on a server instead —
// specifically, in an "environment variable" set in Render's dashboard,
// never typed directly into this file.
// ===========================================================================

// "import" brings in code that other people already wrote, so we don't have
// to build everything from scratch.
import express from "express";           // a toolkit for building web servers
import cors from "cors";                 // lets browsers on other websites call this server
import { GoogleGenAI, Type } from "@google/genai"; // Google's official Gemini AI toolkit

// Create the actual server object. Everything below configures it.
const app = express();

// Without this line, a browser calling this server from a *different*
// website (like your app hosted elsewhere) would be blocked for security
// reasons. This tells the server "it's fine, allow requests from anywhere."
app.use(cors());

// This tells the server "expect incoming requests to contain JSON data,
// and automatically read/parse it for me." The 15mb limit is raised from
// the default because a photo, once converted to text, is fairly large.
app.use(express.json({ limit: "15mb" }));

// Connect to Google's Gemini AI using our secret key. process.env.GEMINI_API_KEY
// reads the key from Render's "Environment Variables" settings — it is
// never written here as actual text.
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// This is the instruction text we send to the AI every time, explaining
// exactly what we want it to do with the photo. Think of it as a very
// detailed, very patient set of directions for a new employee.
const SYSTEM_PROMPT = `You are a receipt-reading assistant.
You will be given a photo of a restaurant or store receipt. Read all the text in the image yourself, then extract every purchasable line item and every charge (tax, tip/gratuity), plus the date and time of the order.

Rules:
- "Alcohol" = beer, wine, liquor, cocktails, and any other alcoholic beverages (recognize actual drink/brand names, not just the literal word "alcohol").
- "Food" = all other food and non-alcoholic drinks (recognize actual dish/drink names, not just the literal word "food").
- "Tax" = sales tax / VAT / GST lines.
- "Tip" = tip, gratuity, or service charge lines.
- Do NOT include subtotal, total, balance due, change, or payment method lines (card numbers, "visa", "cash", etc.) as items.
- If a price is ambiguous or missing, do your best guess but never invent items that aren't implied by the image.
- Prices must be plain numbers (e.g. 12.99), never strings, never with a currency symbol.
- Also return the raw text you read off the receipt, line by line, in "rawText".

Handwriting: many restaurant receipts have a handwritten tip amount added by the customer, often on a blank "Tip" or "Gratuity" line, sometimes with a handwritten new "Total" underneath it. Read handwritten numbers just as carefully as printed ones.
- If you see a handwritten number next to a printed "Tip"/"Gratuity" line (even if the printed amount was blank or $0.00), use the handwritten number as the Tip amount.
- If the tip line was left blank with no handwritten number at all, do not invent a Tip item.
- A handwritten "Total" is usually just tip added to the printed subtotal — do not add it as its own item, since it would double-count charges already captured as Food/Alcohol/Tax/Tip.
- If handwriting is too unclear to read confidently, prefer leaving that specific number out over guessing.

Date and time:
- Find the order/transaction date and time printed on the receipt (not a "best by" or unrelated date).
- Return "date" as YYYY-MM-DD. If the year isn't printed, assume the current year.
- Return "time" as 24-hour HH:MM (e.g. a receipt showing "12:04 PM" becomes "12:04"; "7:45 PM" becomes "19:45").
- Receipts almost always use numeric dates in MONTH/DAY/YEAR order (this is the U.S. convention) — read "8/5/26" as August 5th, 2026, NOT May 8th. Only treat it as day/month order if the first number is greater than 12, which would make month/day impossible.
- A 2-digit year like "26" means 2026 — assume 20XX for any 2-digit year.
- Worked example: "Ordered: 8/5/26 6:22 PM" means date "2026-08-05" and time "18:22". This exact style (M/D/YY plus 12-hour time) is extremely common on receipts — treat it as clearly readable, not ambiguous, and extract it with high confidence.
- Only leave date/time as an empty string if it's genuinely missing from the receipt or physically unreadable (e.g. torn, smudged past recognition) — a normal, clearly-printed date in a common format like the example above should always be extracted, not skipped out of caution.

Confidence / uncertain fields:
- You will not always be able to read every part of a receipt clearly — bad lighting, blur, faded thermal print, and messy handwriting are all common and expected.
- For every item, set "confidence" to "low" if you are genuinely unsure about its description or price (rather than just picking your best guess silently), and "high" otherwise.
- Do the same for the "dateConfidence" and "timeConfidence" fields, describing your confidence in the "date" and "time" values.
- Being honest about low confidence is more useful than appearing certain — a human will review anything marked "low" before it's used, so it is always safe and correct to mark something "low" when you're not sure.`;

// This describes the EXACT shape of the answer we require the AI to send
// back — like a form with specific fields it must fill in. Gemini will
// refuse to send back anything that doesn't match this shape, which is
// what stops it from returning messy or unpredictable text.
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    rawText: { type: Type.STRING }, // the plain text read off the receipt
    date: { type: Type.STRING },    // order date, format YYYY-MM-DD (or "" if unreadable)
    time: { type: Type.STRING },    // order time, 24-hour HH:MM (or "" if unreadable)
    dateConfidence: { type: Type.STRING, enum: ["high", "low"] },
    timeConfidence: { type: Type.STRING, enum: ["high", "low"] },
    items: {
      type: Type.ARRAY, // a list of...
      items: {
        type: Type.OBJECT, // ...objects, each shaped like:
        properties: {
          desc: { type: Type.STRING },   // the item's name, e.g. "Cheeseburger"
          price: { type: Type.NUMBER },  // the item's price, e.g. 12.99 (a real number, not text)
          category: {
            type: Type.STRING,
            enum: ["Food", "Alcohol", "Tax", "Tip"], // must be exactly one of these four words
          },
          confidence: { type: Type.STRING, enum: ["high", "low"] }, // "low" = please double-check this one
        },
        required: ["desc", "price", "category", "confidence"], // every item must have all four fields
      },
    },
  },
  required: ["items", "rawText", "date", "time", "dateConfidence", "timeConfidence"],
};

// This defines what happens when the phone/browser app sends a photo to:
//   https://your-server.onrender.com/api/categorize
// "app.post" means this only responds to POST requests (requests that are
// delivering data to be processed, as opposed to just asking to view a page).
app.post("/api/categorize", async (req, res) => {
  try {
    // A simple "app password" check. The frontend sends this in a header;
    // if it doesn't match what's set in Render's environment variables,
    // we reject the request before it ever reaches (and costs money on)
    // the AI. This isn't unbreakable — someone determined enough could
    // view the page's source and find the value — but it stops random
    // bots or opportunistic misuse from burning through your AI quota.
    const providedSecret = req.header("X-App-Secret");
    if (process.env.APP_SHARED_SECRET && providedSecret !== process.env.APP_SHARED_SECRET) {
      return res.status(401).json({ error: "Missing or incorrect app secret." });
    }

    // Pull the photo data (and its file type, like "image/jpeg") out of
    // the incoming request. "req.body" is the JSON data the app sent us.
    const { imageBase64, mimeType } = req.body;

    // Sanity check: if there's no photo data at all, stop here and say why.
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res.status(400).json({ error: "Missing 'imageBase64' field in request body." });
    }

    // This is the actual call to Google's AI. We're sending:
    //   - our instructions (SYSTEM_PROMPT)
    //   - the photo itself (inlineData)
    // and telling it to answer using our exact responseSchema shape.
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash", // which AI model to use
      contents: [
        {
          role: "user",
          parts: [
            { text: SYSTEM_PROMPT },
            { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json", // tells Gemini to answer in JSON, not casual sentences
        responseSchema,                        // tells Gemini the exact shape to use (defined above)
        temperature: 0,                        // 0 = "be as consistent/predictable as possible"
      },
    });

    // response.text is the AI's raw answer, as a JSON-formatted string of text.
    const raw = response.text;

    // This prints the AI's answer into Render's "Logs" tab — handy for
    // debugging if something ever looks wrong on the app's end.
    console.log("Raw Gemini response:", raw);

    // Turn that JSON-formatted text into an actual JavaScript object we can use.
    const parsed = JSON.parse(raw);

    // Extra safety check: make sure "items" really is a list, not something broken.
    if (!Array.isArray(parsed.items)) {
      throw new Error("Model did not return an items array.");
    }

    // Send the AI's answer back to the phone/browser app as JSON.
    res.json(parsed);

  } catch (err) {
    // If ANYTHING above goes wrong (bad photo, AI error, network issue, etc.),
    // this catches it so the server doesn't crash, and reports the problem.
    console.error("Categorize error:", err);
    res.status(500).json({ error: "Failed to categorize receipt.", detail: String(err.message || err) });
  }
});

// A simple "is this server alive?" page. Visiting the server's URL directly
// in a browser (with nothing else after it) shows this message.
app.get("/", (req, res) => {
  res.send("Receipt categorizer backend is running.");
});

// Starts the server listening for requests. Render tells us which port to
// use via process.env.PORT; if that's not set (e.g. testing on your own
// computer), it falls back to port 3000.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
