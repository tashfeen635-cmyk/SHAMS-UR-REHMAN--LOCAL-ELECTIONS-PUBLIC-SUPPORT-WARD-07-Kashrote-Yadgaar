import "dotenv/config";
import { createMongoStore } from "../lib/mongo-store.mjs";

const required = ["MONGODB_URI", "DEVICE_SECRET", "ADMIN_TOKEN"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

try {
  const store = await createMongoStore();
  const count = (await store.readResponses()).length;
  const database = process.env.MONGODB_DB ?? "shams_survey";
  console.log(`MongoDB OK (database=${database}, responses=${count})`);
  if (process.env.TRUST_PROXY !== "1") {
    console.log("Note: TRUST_PROXY is not 1; set it to 1 on Vercel.");
  }
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MongoDB check failed: ${message.replaceAll(process.env.MONGODB_URI, "[redacted]")}`);
  process.exit(1);
}
