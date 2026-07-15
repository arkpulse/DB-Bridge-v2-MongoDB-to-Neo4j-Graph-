const express = require("express");
const mongoose = require("mongoose");
const neo4j = require("neo4j-driver");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/studentdb";
const NEO4J_URI = process.env.NEO4J_URI || "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASS = process.env.NEO4J_PASS || "password123";
const MIGRATE_INTERVAL_MS = parseInt(process.env.MIGRATE_INTERVAL_MS || "5000");

// ─── MONGOOSE SCHEMA ────────────────────────────────────────────────────────
const studentSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  age:        { type: Number, required: true },
  department: { type: String, required: true },
  gpa:        { type: Number, required: true },
  courses:    [String],
  city:       { type: String, required: true },
  email:      { type: String, required: true },
  migratedToNeo4j: { type: Boolean, default: false }, // <-- migration flag
  createdAt:  { type: Date, default: Date.now }
});
const Student = mongoose.model("Student", studentSchema);

// ─── NEO4J DRIVER ───────────────────────────────────────────────────────────
const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USER, NEO4J_PASS)
);

// ─── WAIT FOR MONGODB ───────────────────────────────────────────────────────
async function connectMongo() {
  let retries = 15;
  while (retries--) {
    try {
      await mongoose.connect(MONGO_URI);
      console.log("✅ MongoDB connected");
      return;
    } catch (e) {
      console.log(`MongoDB not ready, retrying... (${retries} left)`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error("❌ MongoDB failed");
}

// ─── WAIT FOR NEO4J ─────────────────────────────────────────────────────────
async function waitForNeo4j() {
  let retries = 20;
  while (retries--) {
    try {
      const session = driver.session();
      await session.run("RETURN 1");
      await session.close();
      console.log("✅ Neo4j connected");
      return;
    } catch (e) {
      console.log(`Neo4j not ready, retrying... (${retries} left)`);
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  throw new Error("❌ Neo4j failed");
}

// ─── AUTO-MIGRATION SCRIPT ──────────────────────────────────────────────────
// This runs every MIGRATE_INTERVAL_MS milliseconds.
// It finds all MongoDB students NOT yet migrated → pushes them to Neo4j → marks them as migrated.
async function runMigration() {
  const pending = await Student.find({ migratedToNeo4j: false });
  if (pending.length === 0) return;

  console.log(`🔄 Auto-migrating ${pending.length} new student(s) to Neo4j...`);
  const session = driver.session();

  try {
    for (const s of pending) {
      const id = s._id.toString();

      // Create Student node
      await session.run(
        `MERGE (st:Student {mongoId: $id})
         SET st.name = $name, st.age = $age, st.gpa = $gpa, st.email = $email`,
        { id, name: s.name, age: s.age, gpa: s.gpa, email: s.email }
      );

      // Department node + relationship
      await session.run(
        `MERGE (d:Department {name: $dept})
         WITH d MATCH (st:Student {mongoId: $id})
         MERGE (st)-[:STUDIES_IN]->(d)`,
        { dept: s.department, id }
      );

      // City node + relationship
      await session.run(
        `MERGE (c:City {name: $city})
         WITH c MATCH (st:Student {mongoId: $id})
         MERGE (st)-[:LIVES_IN]->(c)`,
        { city: s.city, id }
      );

      // Course nodes + relationships
      for (const course of (s.courses || [])) {
        if (!course.trim()) continue;
        await session.run(
          `MERGE (co:Course {name: $course})
           WITH co MATCH (st:Student {mongoId: $id})
           MERGE (st)-[:ENROLLED_IN]->(co)`,
          { course: course.trim(), id }
        );
      }

      // Mark as migrated in MongoDB
      await Student.findByIdAndUpdate(s._id, { migratedToNeo4j: true });
      console.log(`  ✅ Migrated: ${s.name}`);
    }
  } finally {
    await session.close();
  }
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

// GET - Backend landing/status helper
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "DB Bridge backend is running.",
    note: "MongoDB runs on port 27017 for database drivers, not browser HTTP.",
    endpoints: {
      health: "/api/health",
      status: "/api/status",
      students: "/api/students",
      graph: "/api/graph"
    },
    frontend: {
      form: "frontend/form.html",
      graph: "frontend/graph.html"
    }
  });
});

// POST — Save student from form → MongoDB
app.post("/api/students", async (req, res) => {
  try {
    const { name, age, department, gpa, courses, city, email } = req.body;
    if (!name || !age || !department || !gpa || !city || !email) {
      return res.status(400).json({ success: false, error: "All fields required" });
    }
    const courseList = typeof courses === "string"
      ? courses.split(",").map(c => c.trim()).filter(Boolean)
      : (courses || []);

    const student = new Student({ name, age: Number(age), department, gpa: Number(gpa), courses: courseList, city, email });
    await student.save();
    console.log(`📥 New student saved to MongoDB: ${name}`);
    res.json({ success: true, message: `${name} saved to MongoDB! Auto-migration will run in seconds.`, student });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET — All students from MongoDB (for status page)
app.get("/api/students", async (req, res) => {
  try {
    const students = await Student.find().sort({ createdAt: -1 });
    res.json({ success: true, data: students });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET — Neo4j graph data (nodes + edges for D3)
app.get("/api/graph", async (req, res) => {
  const session = driver.session();
  try {
    // Get all nodes
    const nodeResult = await session.run(
      `MATCH (n) RETURN id(n) AS id, labels(n)[0] AS label, n.name AS name, 
       n.gpa AS gpa, n.age AS age, n.email AS email`
    );
    const nodes = nodeResult.records.map(r => ({
      id: r.get("id").toString(),
      label: r.get("label"),
      name: r.get("name"),
      gpa: r.get("gpa"),
      age: r.get("age"),
      email: r.get("email"),
    }));

    // Get all edges
    const edgeResult = await session.run(
      `MATCH (a)-[r]->(b) RETURN id(a) AS from, id(b) AS to, type(r) AS type`
    );
    const edges = edgeResult.records.map(r => ({
      source: r.get("from").toString(),
      target: r.get("to").toString(),
      type: r.get("type"),
    }));

    res.json({ success: true, nodes, edges });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    await session.close();
  }
});

// GET — Migration status
app.get("/api/status", async (req, res) => {
  try {
    const total = await Student.countDocuments();
    const migrated = await Student.countDocuments({ migratedToNeo4j: true });
    const pending = total - migrated;
    res.json({ success: true, total, migrated, pending });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ─── START ───────────────────────────────────────────────────────────────────
async function start() {
  await connectMongo();
  await waitForNeo4j();

  // Start auto-migration loop
  console.log(`🤖 Auto-migration script started (every ${MIGRATE_INTERVAL_MS / 1000}s)`);
  setInterval(runMigration, MIGRATE_INTERVAL_MS);

  app.listen(3001, () => console.log("🚀 Backend on http://localhost:3001"));
}

start().catch(console.error);
