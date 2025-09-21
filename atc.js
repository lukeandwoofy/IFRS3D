// atc.js — ATC module (pluggable provider)
// Exports: attach, init, sendATC, dispose
// Behavior:
//  - If CONFIG.ATC.COHERE_API_KEY is set, uses Cohere chat endpoint to generate ATC replies.
//  - Otherwise falls back to a small rule-based responder suitable for testing.
//  - Exposes sendATC(text, App) -> Promise<string>
// Dependencies: fetch, main.js providing App, CONFIG, U

let App, CONFIG, U;
let elems = {};
let controllerContext = `You are an air traffic controller. Reply concisely in plain ICAO-style phraseology. Use short sentences. Always include a call sign if the pilot provides one, otherwise use "AIRCRAFT".`;

// Attach references from main
export function attach(app, config, util) {
  App = app;
  CONFIG = config;
  U = util;
}

// Init (wire UI optionally)
export function init() {
  elems.atcOutput = document.getElementById('atcOutput');
  elems.atcInput = document.getElementById('atcInput');
  elems.atcSend = document.getElementById('atcSend');

  // If UI present and atcSend exists, we don't directly hook here because ui.js handles UI.
  // This init simply ensures module is ready.
}

// Primary API: sendATC
export async function sendATC(pilotText, appRef) {
  const app = appRef || App;
  const trimmed = (pilotText || '').trim();
  if (!trimmed) return 'No transmission';

  // If Cohere API key supplied in CONFIG, attempt to call Cohere Chat
  const cohKey = CONFIG?.ATC?.COHERE_API_KEY || '';
  if (cohKey) {
    try {
      const prompt = [
        { role: 'system', content: controllerContext },
        { role: 'user', content: `Pilot: ${trimmed}\nAircraft position: ${formatPos(app)}\nProvide a single short ATC reply.` }
      ];
      const body = {
        messages: prompt,
        temperature: 0.2,
        max_tokens: 160,
        // model choice intentionally left to provider default
      };

      const res = await fetch(CONFIG.ATC.COHERE_ENDPOINT || 'https://api.cohere.ai/v1/chat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cohKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const txt = await res.text().catch(()=>`HTTP ${res.status}`);
        console.warn('[atc] Cohere HTTP error:', txt);
        return fallbackReply(trimmed, app);
      }

      const j = await res.json().catch(() => null);
      // Attempt to extract assistant reply from common Cohere structure
      const assistant = j?.message?.content || j?.outputs?.[0]?.content?.[0]?.text || j?.reply || null;
      if (assistant && typeof assistant === 'string') {
        return sanitizeReply(assistant);
      }
      // Try typical chat array
      if (Array.isArray(j?.messages)) {
        const last = j.messages.slice(-1)[0];
        if (last && last.content) return sanitizeReply(last.content);
      }

      return fallbackReply(trimmed, app);
    } catch (e) {
      console.warn('[atc] Cohere request failed:', e);
      return fallbackReply(trimmed, app);
    }
  }

  // No external AI available: use fallback rule-based responder
  return fallbackReply(trimmed, app);
}

// Dispose (no persistent resources)
export function dispose() {
  // nothing to clean up
}

// ------------------------
// Helpers
// ------------------------
function formatPos(app) {
  if (!app) return 'unknown';
  const lat = (U && U.rad2deg ? U.rad2deg(app.latRad) : (app.latRad || 0));
  const lon = (U && U.rad2deg ? U.rad2deg(app.lonRad) : (app.lonRad || 0));
  const altM = Math.round((app.heightM || 0));
  const kts = Math.round((U && U.ms2kts ? U.ms2kts(app.speedMS || 0) : (app.speedMS || 0)));
  const hdg = Math.round((U && U.rad2deg ? (U.rad2deg(app.heading || 0) + 360) % 360 : (app.heading || 0)));
  return `lat ${lat.toFixed(4)} lon ${lon.toFixed(4)} alt ${altM}m speed ${kts}kts hdg ${hdg}°`;
}

function sanitizeReply(text) {
  // Minimal sanitization: trim and collapse whitespace, ensure short reply
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length > 420) return t.slice(0, 417) + '...';
  return t;
}

function fallbackReply(pilotText, app) {
  // Quick heuristics to generate reasonable ATC-like responses
  const txt = pilotText.toLowerCase();

  // Extract possible callsign
  const cs = extractCallsign(pilotText) || 'AIRCRAFT';

  // Basic intents
  if (/request.*(start|push|taxi|engine|departure)/i.test(pilotText) || /ready to taxi|request taxi/i.test(pilotText)) {
    return `${cs} taxi to runway via taxiway A, hold short, advise ready for departure`;
  }
  if (/request.*(takeoff|departure|departure clearance|ready for departure)/i.test(pilotText) || /ready for departure/i.test(pilotText)) {
    return `${cs} hold short runway, expect departure on runway, squawk 1234`;
  }
  if (/request.*(landing|approach|ils|visual)/i.test(pilotText) || /request landing/i.test(pilotText)) {
    return `${cs} cleared visual approach runway 27, report final`;
  }
  if (/\b(position|where)\b/i.test(pilotText) || /where am i/i.test(pilotText)) {
    return `${cs} you are ${formatPos(app)}`;
  }
  if (/request.*(frequency|contact)/i.test(pilotText)) {
    return `${cs} contact tower on 118.1`;
  }
  if (/mayday|pan-pan/i.test(txt)) {
    return `${cs} mayday acknowledged, squawk 7700, declare nature of emergency`;
  }
  if (/check (in|inbound)/i.test(txt) || /position report/i.test(txt)) {
    return `${cs} roger, maintain present heading and altitude, report next`;
  }

  // Otherwise short generic reply
  return `${cs} standby, maintain present heading and altitude, contact tower when ready`;
}

function extractCallsign(text) {
  if (!text) return null;
  // crude heuristic: look for sequences like "ABC123" or "Airline 123"
  const m = text.match(/\b([A-Za-z]{2,}\s?\d{1,4}|[A-Z]{3}\d{1,4}|[A-Za-z]+\d{1,4})\b/);
  if (m) return m[1].toUpperCase();
  return null;
}
