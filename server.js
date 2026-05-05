const express = require('express');
const multer = require('multer');
const axios = require('axios'); // Axios ersetzt Nodemailer
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());
app.use(express.static('.'));

// --- GEMINI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- API ENDPUNKT ---
app.post('/api/reklamation', upload.single('document'), async (req, res) => {
    try {
        console.log("Daten empfangen, KI-Analyse startet...");
        const data = req.body;
        const file = req.file;

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-lite"
        });

        const heute = new Date().toISOString().split('T')[0];

        let imagePart = null;
        if (file) {
            imagePart = {
                inlineData: {
                    data: file.buffer.toString("base64"),
                    mimeType: file.mimetype
                }
            };
        }

        const promptText = `Du bist der Kundenservice- und Qualitätsprüfer-Bot von Engelbert Strauss. 
        Heute ist der ${heute}. Der Kunde ${data.fullName || "Ein Kunde"} hat folgende Reklamation eingereicht:
        
        Produktgruppe: ${data.product || "Nicht angegeben"}
        Artikelnummer: ${data.articleNumber || "Nicht angegeben"}
        Kaufdatum: ${data.date || "Nicht angegeben"}
        Grund: ${data.reason || "Nicht angegeben"}
        Freie Bemerkung des Kunden: "${data.remarks || "Keine"}"
        Wurde ein Bild/Dokument angehängt?: ${file ? "JA" : "NEIN"}

        Deine Aufgaben:
        1. BILDANALYSE (Falls ein Bild vorhanden ist): Beschreibe kurz, was auf dem Bild zu sehen ist. Schätze kritisch ein, ob das Gesehene zur Reklamation passt (z.B. Ist ein Riss am Knie wirklich ein Materialfehler oder normaler Verschleiß? Handelt es sich wirklich um den angegebenen Artikel?). Falls kein Bild angehängt wurde, schreibe "Kein Bild zur Prüfung eingereicht".
        2. PLAUSIBILITÄT: Prüfe logisch, ob diese Reklamation Sinn macht (Kaufdatum, Grund, deine Bildanalyse).
        3. STIMMUNG & PRIORITÄT: Analysiere die Stimmung und leite eine Priorität ab (HOCH, MITTEL, NIEDRIG oder PRÜFUNG NÖTIG).
        4. KUNDENANTWORT (Website): Eine sehr kurze Bestätigung (max 2 Sätze) für den Browser ("Ticket ist eingegangen..."). Sprich den Kunden mit Namen an.
        5. SUPPORT-ENTWURF: Schreibe eine vollständige E-Mail, die der Support-Mitarbeiter 1:1 kopieren und senden kann. 
           - Sprich den Kunden persönlich an (z.B. "Hallo ${data.fullName}").
           - Wenn PLAUSIBEL: Entschuldige dich für den Defekt und kündige z.B. einen kostenlosen Ersatz an.
           - Wenn UNPLAUSIBEL (z.B. Bild zeigt puren Verschleiß): Formuliere eine FREUNDLICHE ABLEHNUNG im Strauss-Stil ('Workwear-Valley', 'Macher'). Gehe dabei zwingend auf das ein, was du auf dem Bild gesehen hast!

        Antworte AUSSCHLIESSLICH in folgendem JSON-Format:
        {
            "bildAnalyse": "Deine Einschätzung zum Bild",
            "plausibel": true oder false,
            "kiEinschaetzung": "Deine interne Begründung zur Plausibilität inkl. Bildbewertung",
            "stimmung": "...",
            "prioritaet": "...",
            "kundenAntwort": "...",
            "supportAntwortEntwurf": "Die komplette, fertige E-Mail an den Kunden"
        }`;

        const requestContent = [promptText];
        if (imagePart) requestContent.push(imagePart);

        const result = await model.generateContent(requestContent);
        
        // Sicherheits-Fix: Bereinigt die KI-Antwort (kopiersichere Variante)
        const aiResponseText = result.response.text();
        let cleanJson = aiResponseText.split("```json").join("");
        cleanJson = cleanJson.split("```").join("").trim();
        const aiData = JSON.parse(cleanJson);
        
        console.log(`KI Analyse | Prio: ${aiData.prioritaet} | Plausibel: ${aiData.plausibel}`);

        // --- EMAIL VERSAND MIT BREVO API ---
        const emailPayload = {
            sender: { name: "Strauss Support Bot", email: "Tuengerthal.Max@googlemail.com" }, // Muss bei Brevo verifiziert sein
            to: [{ email: "Faimzee@gmail.com" }], // Geht immer an dich
            cc: data.testEmail ? [{ email: data.testEmail }] : undefined, // Personaler-CC
            subject: `[${aiData.prioritaet}] ${!aiData.plausibel ? '⚠️ ABLEHNUNG PRÜFEN: ' : ''}Reklamation für Artikel ${data.articleNumber}`,
            textContent: `Reklamations-Details:\n
            Kunde: ${data.fullName}
            E-Mail: ${data.email}
            Adresse: ${data.street || "-"}, ${data.city || "-"}
            
            Produkt: ${data.product}
            Artikelnummer: ${data.articleNumber}
            Kaufdatum: ${data.date}
            Grund: ${data.reason}
            Freie Bemerkung: "${data.remarks || "Keine"}"\n
            ------------------------------------------
            🤖 KI-TICKET-ANALYSE:
            Stimmung des Kunden: ${aiData.stimmung}
            Abgeleitete Priorität: ${aiData.prioritaet}
            
            🖼️ BILD- / DOKUMENTENANALYSE:
            ${aiData.bildAnalyse}

            🔍 PLAUSIBILITÄTSPRÜFUNG:
            Ist die Reklamation logisch/plausibel?: ${aiData.plausibel ? "✅ JA" : "❌ NEIN (Verdachtsfall / Kein Garantiefall)"}
            Begründung der KI: "${aiData.kiEinschaetzung}"
            ------------------------------------------
            ✉️ KI-ENTWURF FÜR DEINE ANTWORT-EMAIL:
            (Einfach kopieren und an den Kunden senden)
            
            ${aiData.supportAntwortEntwurf}
            ------------------------------------------\n
            Sofort-Antwort auf der Website war:\n${aiData.kundenAntwort}`,
            
            // Wenn ein Bild existiert, an Brevo anhängen
            attachment: file ? [{ 
                content: file.buffer.toString('base64'), 
                name: file.originalname 
            }] : undefined
        };

        // Brevo API Call (HTTP statt SMTP - wird von Render NICHT blockiert)
        try {
            await axios.post('https://api.brevo.com/v3/smtp/email', emailPayload, {
                headers: {
                    'api-key': process.env.BREVO_API_KEY,
                    'Content-Type': 'application/json'
                }
            });
            console.log("Email erfolgreich via Brevo API versandt!");
        } catch (mailError) {
            console.error("Brevo API Fehler:", mailError.response ? mailError.response.data : mailError.message);
        }

        res.status(200).json({ status: 'success', aiMsg: aiData.kundenAntwort });

    } catch (error) {
        console.error("Server-Fehler:", error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`--------------------------------------------------`);
    console.log(`🚀 Server läuft auf Port ${PORT}`);
    console.log(`🧠 KI-Copilot: AKTIVIERT`);
    console.log(`👁️ Multimodale Bilderkennung: AKTIVIERT`);
    console.log(`📬 Personaler-Test-Routing (Brevo API): AKTIVIERT`);
    console.log(`--------------------------------------------------`);
});
