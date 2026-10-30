import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { config } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { bullBoardAuth } from "./middleware/bullBoardAuth.js";
import { emailQueue } from "./queues/emailQueue.js";
import { emailRoutes } from "./routes/emailRoutes.js";
import { authRoutes } from "./routes/authRoutes.js";
import { healthRoutes } from "./routes/healthRoutes.js";
import { slackRoutes } from "./routes/slackRoutes.js";
import { userRoutes } from "./routes/userRoutes.js";

export const app = express();

app.use(helmet());
app.use(cors({ origin: new URL(config.FRONTEND_URL).origin, credentials: true }));
app.use(express.json({ limit: config.API_JSON_LIMIT_BYTES }));

app.use("/health", healthRoutes);
app.use("/auth", authRoutes);
app.use("/api", userRoutes);
app.use("/api/emails", emailRoutes);
app.use("/api/slack", slackRoutes);

const bullBoardAdapter = new ExpressAdapter();
bullBoardAdapter.setBasePath("/admin/queues");
createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter: bullBoardAdapter
});
app.use("/admin/queues", bullBoardAuth, bullBoardAdapter.getRouter());

app.use(errorHandler);
