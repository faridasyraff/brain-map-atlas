import http from "http";
import dotenv from "dotenv";
import { mapQuestionToRegions } from "./GPTWrapper/AIQuery.js";

dotenv.config();

const PORT = 5001;

const server = http.createServer((req, res) => {

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(200);
        return res.end();
    }

    if (req.method === "POST" && req.url === "/api/ask-ai") {

        let body = "";

        req.on("data", chunk => {
            body += chunk.toString();
        });

        req.on("end", async () => {
            try {
                const { question } = JSON.parse(body);

                if (!question) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "Question required" }));
                }

                const result = await mapQuestionToRegions(question);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result));

            } catch (err) {
                console.error("AI error:", err);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "AI failed" }));
            }
        });

    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
});
