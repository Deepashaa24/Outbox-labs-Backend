import { Router } from "express";
import {
  handleGoogleOAuthCallback,
  logout,
  startGoogleOAuth
} from "../controllers/authController.js";
import { connectSlack, slackOAuthCallback } from "../controllers/slackController.js";
import { authenticateUser } from "../middleware/authenticateUser.js";

export const authRoutes = Router();

authRoutes.get("/google", startGoogleOAuth);
authRoutes.get("/google/callback", handleGoogleOAuthCallback);
authRoutes.get("/slack/connect", authenticateUser, connectSlack);
authRoutes.get("/slack/callback", slackOAuthCallback);
authRoutes.post("/logout", logout);
