const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = "openai/gpt-4o-mini";
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

app.use(express.json());
app.use(express.static(__dirname));

function maybeHandleUpload(req, res, next) {
    if ((req.headers["content-type"] || "").includes("multipart/form-data")) {
        return upload.single("attachment")(req, res, next);
    }

    next();
}

function parseHistory(rawHistory) {
    if (!rawHistory) {
        return [];
    }

    if (Array.isArray(rawHistory)) {
        return rawHistory;
    }

    try {
        return JSON.parse(rawHistory);
    } catch {
        return [];
    }
}

async function buildAttachmentContent(file) {
    if (!file) {
        return null;
    }

    if (file.mimetype.startsWith("image/")) {
        const base64Image = file.buffer.toString("base64");
        return [
            {
                type: "text",
                text: `The user uploaded an image named "${file.originalname}". Analyze it and answer the user's question about it.`
            },
            {
                type: "image_url",
                image_url: {
                    url: `data:${file.mimetype};base64,${base64Image}`
                }
            }
        ];
    }

    if (file.mimetype === "application/pdf") {
        const pdfData = await pdfParse(file.buffer);
        const extractedText = (pdfData.text || "").trim().slice(0, 16000);

        if (!extractedText) {
            throw new Error("Could not read text from the uploaded PDF.");
        }

        return `The user uploaded a PDF file named "${file.originalname}". Use this extracted text to answer the question:\n\n${extractedText}`;
    }

    const extractedText = file.buffer.toString("utf8").trim().slice(0, 16000);
    if (!extractedText) {
        throw new Error("The uploaded file is empty or unsupported.");
    }

    return `The user uploaded a file named "${file.originalname}". Use this file content to answer the question:\n\n${extractedText}`;
}

app.post("/api/chat", maybeHandleUpload, async (req, res) => {
    try {
        if (!OPENROUTER_API_KEY) {
            return res.status(500).json({
                error: "Missing OPENROUTER_API_KEY. Set it before starting the server."
            });
        }

        const body = req.body || {};
        const message = body.message;
        const history = parseHistory(body.history);
        if (!message) {
            return res.status(400).json({ error: "Message is required." });
        }

        const formattedHistory = history
            .filter((item) => item && item.role && item.content)
            .map((item) => ({
                role: item.role === "ai" ? "assistant" : item.role,
                content: item.content
            }));

        const attachmentContent = await buildAttachmentContent(req.file);
        const userContent = [];

        if (attachmentContent) {
            if (Array.isArray(attachmentContent)) {
                userContent.push(...attachmentContent);
            } else {
                userContent.push({
                    type: "text",
                    text: attachmentContent
                });
            }
        }

        userContent.push({
            type: "text",
            text: req.file
                ? `User question about the uploaded file: ${message}`
                : message
        });

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "College Chatbot"
            },
            body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages: [
                    {
                        role: "system",
                        content: "You are Pirate Aura, a professional and helpful AI assistant. Answer the user's exact question directly in simple English. When the user uploads an image or file, read it carefully and answer based on that content. Do not assume the topic. If the user asks for the meaning of a name, explain that name. If the user asks a short follow-up like 'yes', use the recent chat history to understand it. Keep answers clear, relevant, and concise."
                    },
                    ...formattedHistory.map((item) => ({
                        role: item.role,
                        content: item.content
                    })),
                    {
                        role: "user",
                        content: userContent
                    }
                ]
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: data.error?.message || "OpenRouter request failed."
            });
        }

        const reply = data.choices?.[0]?.message?.content || "I could not generate a response.";
        return res.json({ reply });
    } catch (error) {
        return res.status(500).json({
            error: error.message || "Unexpected server error."
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
