import { Router } from "express";
import { getCurrentUser } from "../controllers/authController.js";
import { authenticateUser } from "../middleware/authenticateUser.js";

export const userRoutes = Router();

userRoutes.get("/me", authenticateUser, getCurrentUser);
