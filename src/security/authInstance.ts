import { config } from "../config/env";
import { AdminAuth } from "./adminAuth";

export const adminAuth = new AdminAuth(() => config);
