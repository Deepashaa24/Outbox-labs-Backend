import { Router } from "express";
import {
  createEmailJob,
  createScheduledBatch,
  getEmailJobs,
  getEmailLimits,
  getScheduledEmailJobs,
  getSentEmailJobs,
  searchEmails
} from "../controllers/emailController.js";
import { authenticateUser } from "../middleware/authenticateUser.js";

export const emailRoutes = Router();

emailRoutes.use(authenticateUser);
emailRoutes.get("/limits", getEmailLimits);
emailRoutes.get("/", getEmailJobs);
emailRoutes.post("/", createEmailJob);
emailRoutes.post("/schedule", createScheduledBatch);
emailRoutes.get("/scheduled", getScheduledEmailJobs);
emailRoutes.get("/sent", getSentEmailJobs);
emailRoutes.get("/search", searchEmails);
