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
You will be given a photo of a restaurant or store receipt. Read all the text in the image yourself, then extract every purchasable line item and every charge (tax, tip/gratuity).

Rules:
- "Alcohol" = beer, wine, liquor, cocktails, and any other alcoholic beverages (recognize actual drink/brand names, not just the literal word "alcohol").
- "Food" = all other food and non-alcoholic drinks (recognize actual dish/drink names, not just the literal word "food").
- "Tax" = sales tax / VAT / GST lines.
- "Tip" = tip, gratuity, or service charge lines.
- Do NOT include subtotal, total, balance due, change, or payment method lines (card numbers, "visa", "cash", etc.) as items.
- If a price is ambiguous or missing, do your best guess but never invent items that aren't implied by the image.
- Prices must be plain numbers (e.g. 12.99), never strings, never with a currency symbol.
- Also return the raw text you read off the receipt, line by line, in "rawText".`;

// This describes the EXACT shape of the answer we require the AI to send
// back — like a form with specific fields it must fill in. Gemini will
// refuse to send back anything that doesn't match this shape, which is
// what stops it from returning messy or unpredictable text.
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    rawText: { type: Type.STRING }, // the plain text read off the receipt
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
        },
        required: ["desc", "price", "category"], // every item must have all three fields
      },
    },
  },
  required: ["items", "rawText"],
};

// This defines what happens when the phone/browser app sends a photo to:
//   https://your-server.onrender.com/api/categorize
// "app.post" means this only responds to POST requests (requests that are
// delivering data to be processed, as opposed to just asking to view a page).
app.post("/api/categorize", async (req, res) => {
  try {
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
