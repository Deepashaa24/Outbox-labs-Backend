import { Client } from "@elastic/elasticsearch";
import { config } from "./env.js";

export const elasticsearch = new Client({ node: config.ELASTICSEARCH_URL });
