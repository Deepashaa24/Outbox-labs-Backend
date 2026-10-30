import { Router } from "express";
import {
  disconnectSlack,
  getSlackStatus,
  sendSlackTest
} from "../controllers/slackController.js";
import { authenticateUser } from "../middleware/authenticateUser.js";

export const slackRoutes = Router();

slackRoutes.use(authenticateUser);
slackRoutes.get("/status", getSlackStatus);
slackRoutes.post(["/test-message", "/test"], sendSlackTest);
slackRoutes.delete("/disconnect", disconnectSlack);
