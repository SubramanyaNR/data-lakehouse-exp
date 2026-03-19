const adapter = process.env.DB_ADAPTER || "postgres";

let db;

if (adapter === "kafka") {
  db = require("./kafka");
} else {
  db = require("./postgres");
}

module.exports = db;
