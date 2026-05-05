const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());
app.use(express.static('.'));

// --- GEMINI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- EMAIL SETUP ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'Faimzee@gmail.com',
        pass: process.env.EMAIL_PASS 
    }
});

// --- API ENDPUNKT ---
app.post('/api/reklamation', upload.single('document'), async (req, res) => {
    try {
        console.log("Daten empfangen, KI-Analyse startet...");
        const data = req.body;
        const file = req.file;

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-lite",
            generationConfig: { responseMimeType: "application/json" }
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
        const aiResponseText = result.response.text();
        const aiData = JSON.parse(aiResponseText);
        
        console.log(`KI Analyse | Prio: ${aiData.prioritaet} | Plausibel: ${aiData.plausibel}`);

        // Email Versand vorbereiten (MIT optionalem Personaler-CC)
        const mailOptions = {
            from: 'Strauss Support Bot <Faimzee@gmail.com>',
            to: 'Faimzee@gmail.com', // Geht immer an dich als Support-Zentrale
            cc: data.testEmail ? data.testEmail : undefined, // FÜGT DEN PERSONALER HINZU, WENN AUSGEFÜLLT!
            subject: `[${aiData.prioritaet}] ${!aiData.plausibel ? '⚠️ ABLEHNUNG PRÜFEN: ' : ''}Reklamation für Artikel ${data.articleNumber}`,
            text: `Reklamations-Details:\n
            Kunde: ${data.fullName}
            E-Mail: ${data.email}
            Adresse: ${data.street}, ${data.city}
            
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
            attachments: file ? [{ filename: file.originalname, content: file.buffer }] : []
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) console.log("Mail-Fehler:", error);
            else console.log("Email erfolgreich versandt!");
        });

        res.status(200).json({ status: 'success', aiMsg: aiData.kundenAntwort });

    } catch (error) {
        console.error("Server-Fehler:", error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`--------------------------------------------------`);
    console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
    console.log(`🧠 KI-Copilot: AKTIVIERT`);
    console.log(`👁️ Multimodale Bilderkennung: AKTIVIERT`);
    console.log(`📬 Personaler-Test-Routing: AKTIVIERT`);
    console.log(`--------------------------------------------------`);
});