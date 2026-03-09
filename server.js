require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const app = express();
const port = 3000;

// Security & Token Setup
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-freight-key-change-this';
const FREE_TOKENS = 4;
const PAID_TOKENS = 10;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());
app.use(cookieParser());

// Rate Limiter: Max 10 requests per hour per IP to prevent API spam
const apiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, 
    max: 10,
    message: { error: "Too many audit requests from this IP, please try again after an hour." }
});

// Middleware: Check or Initialize JWT Tokens
function tokenManager(req, res, next) {
    let tokenData;
    if (req.cookies.audit_token) {
        try {
            tokenData = jwt.verify(req.cookies.audit_token, JWT_SECRET);
        } catch (err) {
            tokenData = { tokens: FREE_TOKENS }; // Reset if tampered
        }
    } else {
        tokenData = { tokens: FREE_TOKENS }; // New user
    }
    
    req.userTokens = tokenData.tokens;
    next();
}

function updateTokenCookie(res, tokenCount) {
    const newToken = jwt.sign({ tokens: tokenCount }, JWT_SECRET);
    res.cookie('audit_token', newToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
}

function fileToGenerativePart(filePath, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
            mimeType
        },
    };
}

// Generate Watermarked PDF in Memory
function generateDisputePDF(auditData) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50 });
        let buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            resolve(Buffer.concat(buffers).toString('base64'));
        });

        // PDF Content
        doc.fontSize(20).text('Freight Audit Dispute Note', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Load ID: ${auditData.audit_summary.load_id || 'N/A'}`);
        doc.text(`Match Status: ${auditData.audit_summary.match_status ? 'Passed' : 'Discrepancy Found'}`);
        doc.moveDown();
        doc.fontSize(14).text('Dispute Details:', { underline: true });
        doc.fontSize(12).text(auditData.discrepancy_details);
        
        // The Watermark / Security Footer
        doc.moveDown(4);
        doc.fontSize(10).fillColor('gray').text(`Audited by Freight AI - ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.text(`Generated MVP Security ID: ${Math.random().toString(36).substr(2, 9).toUpperCase()}`, { align: 'center' });
        
        doc.end();
    });
}

// --- Get Current Token Status on Page Load ---
app.get('/api/status', tokenManager, (req, res) => {
    res.json({ tokens: req.userTokens });
});

// Main Audit Endpoint
app.post('/api/audit', apiLimiter, tokenManager, upload.array('documents', 3), async (req, res) => {
    console.log(`\n--- 📥 New Audit Request | Tokens Remaining: ${req.userTokens} ---`);

    // Block if out of tokens
    if (req.userTokens <= 0) {
        if (req.files) req.files.forEach(file => fs.unlinkSync(file.path));
        return res.status(403).json({ error: "OUT_OF_TOKENS" });
    }

    try {
        if (!req.files || req.files.length === 0 || req.files.length > 3) {
            return res.status(400).json({ error: "Please upload between 1 and 3 freight documents." });
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // Forcing Render update for Gemini model

        const imageParts = req.files.map(file => {
            let mimeType = 'text/plain';
            if (file.mimetype === 'application/pdf') mimeType = 'application/pdf';
            else if (file.mimetype === 'image/jpeg') mimeType = 'image/jpeg';
            else if (file.mimetype === 'image/png') mimeType = 'image/png';
            else if (file.mimetype === 'text/csv') mimeType = 'text/csv';
            return fileToGenerativePart(file.path, mimeType);
        });

        const prompt = `
        You are a Senior Freight Auditor. Analyze the provided PDF, CSV, or TXT files.
        Compare them across these 4 specific Audit Categories.

        🎯 TARGET KEYWORDS FOR DENSE TEXT:
        - RATE CON: Scan for "Linehaul", "Total Rate", "Carrier Pay", "Agreed Amount", "Flat Rate".
        - BOL: Scan for "Weight", "lbs", "Pieces", "Pallets". Look specifically near "Received by" or "Shipper".
        - INVOICE: Scan for "Amount Due", "Total Billed", "Detention", "Lumper", "Fuel Surcharge".

        CRITICAL INSTRUCTION: You must respond with ONLY valid JSON. Do NOT include any conversational text.

        Output JSON Schema:
        {
          "audit_summary": { "load_id": "string", "match_status": boolean, "discrepancy_found": boolean },
          "extracted_values": {
            "rate_con": {"total": 0.00, "weight": 0, "accessorials": []},
            "bol": {"weight": 0, "is_signed": boolean, "declared_value": 0.00},
            "invoice": {"total": 0.00, "weight": 0, "fees_found": []}
          },
          "discrepancy_tldr": ["Short bullet point 1"],
          "discrepancy_details": "Detailed paragraph explaining what is wrong for a dispute."
        }
        `;

        const result = await model.generateContent([prompt, ...imageParts]);
        const responseText = result.response.text();
        
        const startIndex = responseText.indexOf('{');
        const endIndex = responseText.lastIndexOf('}');
        if (startIndex === -1 || endIndex === -1) throw new Error("AI did not return valid JSON.");
        
        const auditData = JSON.parse(responseText.substring(startIndex, endIndex + 1));
        
        // Generate PDF
        const pdfBase64 = await generateDisputePDF(auditData);

        // Deduct Token and Update Cookie
        const newTotal = req.userTokens - 1;
        updateTokenCookie(res, newTotal);

        req.files.forEach(file => fs.unlinkSync(file.path));
        
        // Send JSON + PDF + Token State
        res.json({ ...auditData, tokens_remaining: newTotal, pdf_download: pdfBase64 });

    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.message);
        if (req.files) req.files.forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
        res.status(500).json({ error: "Server failed to process audit." });
    }
});

// --- STRIPE NO-DB IMPLEMENTATION ---
app.post('/api/checkout', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: { currency: 'usd', product_data: { name: '10 Freight AI Audits' }, unit_amount: 1500 }, // $15.00
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/api/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/`,
        });
        res.json({ url: session.url });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Verify payment and refill tokens
app.get('/api/success', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        if (session.payment_status === 'paid') {
            updateTokenCookie(res, PAID_TOKENS);
            res.redirect('/?payment=success');
        } else {
            res.redirect('/');
        }
    } catch (e) {
        res.redirect('/');
    }
});

// --- EMAIL NOTIFICATION WAITLIST ---
app.post('/api/waitlist', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: "Invalid email" });
    
    try {
        // Configure the email sender
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        // Draft the email to yourself
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_USER, // Sends directly to your inbox
            subject: '🚀 New Freight AI MVP Lead!',
            text: `A new user just joined the waitlist!\n\nEmail: ${email}\nTime: ${new Date().toLocaleString()}`
        };

        // Send it
        await transporter.sendMail(mailOptions);
        res.json({ success: true });
        
    } catch (error) {
        console.error("Email Error:", error);
        res.status(500).json({ error: "Failed to join waitlist." });
    }
});

app.listen(port, () => { console.log(`Freight Audit MVP running at http://localhost:${port}`); });