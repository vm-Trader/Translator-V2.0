# Translator by VM (V2.0)

An Apple-style multilingual assistant built with Cloudflare Pages + Gemini API.

## ✨ Features
- Input in **English, Vietnamese, or Hinglish**
- Shows **Improved version** (clean, natural) + **Translation**
- Apple-like UI: clean bubbles, timestamps, typing dots
- Copy buttons for improved + translation text
- Friendly error handling

## 🚀 Deployment (Cloudflare Pages)
1. Clone this repo and connect it to Cloudflare Pages.
2. Add Environment Variable:
   - `GEMINI_API_KEY = your_key_here`
3. Deploy → Live at `https://translator-vm.pages.dev`

## 📂 Structure
- `index.html` → Frontend (UI)
- `functions/gemini.js` → Cloudflare Function for Gemini API

## 🔑 Notes
- Hinglish input is auto-converted to English → translated to Vietnamese
- No Chinese output in this version
