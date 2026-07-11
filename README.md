# DB Bridge v2 — Student Form → MongoDB → Neo4j Graph

## New Flow (Teacher's Requirements)
1. User fills **form.html** → data POSTed to backend → stored in **MongoDB**
2. Backend **auto-migration script** polls every 5 seconds → finds new students → pushes them to **Neo4j** automatically
3. **graph.html** shows a live interactive D3.js force graph of Neo4j data (auto-refreshes every 5s)

## Project Structure
```
db-bridge-v2/
├── docker-compose.yml        ← MongoDB + Neo4j + Backend
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js             ← API + auto-migration script (setInterval)
└── frontend/
    ├── form.html             ← Page 1: Student registration form
    └── graph.html            ← Page 2: Live Neo4j graph visualization
```

## How to Run

### Step 1 — Start Docker
```bash
cd db-bridge-v2
docker compose up --build
```
Starts MongoDB (27017), Neo4j (7474/7687), Node.js backend (3001).

### Step 2 — Open Page 1 (Form)
Open `frontend/form.html` in your browser.
Fill in a student's details and click **Save to MongoDB**.

### Step 3 — Watch auto-migration
Within 5 seconds, the backend script automatically picks up the new student from MongoDB and creates nodes + relationships in Neo4j.

### Step 4 — Open Page 2 (Graph)
Open `frontend/graph.html` in your browser.
You'll see an interactive force-directed graph with:
- 🔵 Blue nodes = Students
- 🟠 Orange nodes = Departments
- 🟣 Purple nodes = Cities
- 🟢 Green nodes = Courses

Click any node to inspect its details. The graph auto-refreshes every 5s.

## API Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/students | Save student from form → MongoDB |
| GET  | /api/students | All students from MongoDB |
| GET  | /api/graph    | Nodes + edges from Neo4j for D3 |
| GET  | /api/status   | Migration status counts |

## Key Implementation: Auto-Migration Script
In `server.js`, a `setInterval` runs every 5 seconds:
```js
setInterval(runMigration, 5000);
```
`runMigration()` finds all students with `migratedToNeo4j: false`,
creates graph nodes and relationships in Neo4j, then marks them as migrated.
This is the "automatically programmable script" the teacher asked for.
