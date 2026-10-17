## PayProoof

Stop scams and hidden fees before you send money.

## Introduction

PayProoof is a friction removal tool built to protect people from payment scams and unfair exchange rates. Before you send money, you can paste a message, type an amount or upload a photo. PayProof will tell you if it’s safe, if the rate is fair and exactly what it costs in your own currency.

Leveraging AI to understand unstructured text and images, PayProof extracts the intent (scam check, conversion or rate comparison) and uses live European Central Bank data to do the math. This ensures that while the chat bot understands the request the numbers are always accurate.

We built PayProoof with a core focus on accessibility, ensuring that financial safety tools are usable by everyone, regardless of visual impairment, color blindness or digital confidence.

## Features

- Scam Detection: AI analyses messages for high pressure tactics, fake landlord requests and account change scams.

- Real Rate Conversion: Converts amounts using the live mid-market rate (Frankfurter API).

- Rate Markup Check: Calculates exactly how much money you lose when an airport kiosk or bank offers you a "bad" rate.

- Provider Comparison: Compares what different providers (Wise, banks, airports) actually deliver.

- Accessibility First: Native text to speech, high contrast mode, color blind safe palettes (using shapes + patterns so not just color), and adjustable text sizes.

## Usage

To get started with PayProoof, the hosted version of the product can be used. You can get started immediately at https://pay-prooof.netlify.app

1. Select your home currency from the top right.
2. Use the mode buttons to select Auto, Convert, Rate Check or Scam Check.
3. Type a message, paste a suspicious text or click the camera icon to upload a screenshot.
4. Press Check to see a color coded, receipt style result card

## Architecture & AI Transparency

To ensure transparency and technical soundness, PayProoof splits the workload between AI and deterministic code:

- The AI (LLM): Used only for natural language understanding and image OCR. It reads the user's input and extracts the data into a structured JSON format (e.g., {"type": "scam_check", "amount": 300, "from": "GBP"}). It does not do math.
- The Code (JavaScript): Handles the math, API fetching, and logic. We use the frankfurter.app API to get live exchange rates. The calculation of the markup percentage is done purely in JavaScript to guarantee accuracy.
- Fallback: If the AI API fails or is slow, the frontend has a built-in regex-based localAnalyse function that catches common scam phrases and extracts currency amounts to keep the app functional.

## Resources

- Frankfurter API for live European Central Bank exchange rates.
- Wise for inspiration and rate comparison data.

## Hackathon Context

This project was built for the IKU Hackathon specifically the Wise Task: Max Ease Track. We focused on removing the friction and anxiety from everyday financial transactions, ensuring that safety checks are effortless and inclusive for all users.