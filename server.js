const express = require("express");
const fs = require("fs");
const path = require("path");
const v8 = require("v8");
const os = require("os");

const app = express();

const PORT = process.env.PORT || 3000;
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || "/snapshots";

// --------------------------------------------------
// Application state
// --------------------------------------------------

// Objects stored here are intentionally retained.
// They cannot be garbage collected while references remain.
const leakedObjects = [];

// Temporary allocations are stored here only briefly.
let temporaryObjects = [];

// --------------------------------------------------
// Ensure snapshot directory exists
// --------------------------------------------------

try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    console.log(`Snapshot directory: ${SNAPSHOT_DIR}`);
} catch (err) {
    console.error("Unable to create snapshot directory:", err);
}

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function memoryStats() {
    const memory = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();

    return {
        timestamp: new Date().toISOString(),

        process: {
            pid: process.pid,
            uptimeSeconds: Math.round(process.uptime())
        },

        memory: {
            rssMB: (memory.rss / 1024 / 1024).toFixed(2),
            heapTotalMB: (memory.heapTotal / 1024 / 1024).toFixed(2),
            heapUsedMB: (memory.heapUsed / 1024 / 1024).toFixed(2),
            externalMB: (memory.external / 1024 / 1024).toFixed(2),
            arrayBuffersMB: (
                memory.arrayBuffers / 1024 / 1024
            ).toFixed(2)
        },

        v8Heap: {
            heapSizeLimitMB: (
                heapStats.heap_size_limit / 1024 / 1024
            ).toFixed(2),

            totalHeapSizeMB: (
                heapStats.total_heap_size / 1024 / 1024
            ).toFixed(2),

            usedHeapSizeMB: (
                heapStats.used_heap_size / 1024 / 1024
            ).toFixed(2)
        },

        application: {
            leakedObjectCount: leakedObjects.length,
            temporaryObjectCount: temporaryObjects.length
        },

        host: {
            hostname: os.hostname(),
            platform: process.platform,
            nodeVersion: process.version
        }
    };
}

function allocateObjects(count, payloadSize) {
    const objects = [];

    const payload = "X".repeat(payloadSize);

    for (let i = 0; i < count; i++) {
        objects.push({
            id: i,
            name: `object-${i}`,
            createdAt: Date.now(),
            payload: payload
        });
    }

    return objects;
}

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "UP",
        service: "k8s-heap-demo",
        timestamp: new Date().toISOString()
    });
});

// --------------------------------------------------
// Root
// --------------------------------------------------

app.get("/", (req, res) => {
    res.json({
        application: "Kubernetes Heap Memory Demo",
        version: "1.0.0",
        endpoints: [
            "GET /health",
            "GET /stats",
            "GET /allocate?mb=50",
            "GET /leak?mb=50",
            "GET /release",
            "GET /gc",
            "POST /snapshot",
            "GET /snapshots"
        ]
    });
});

// --------------------------------------------------
// Memory statistics
// --------------------------------------------------

app.get("/stats", (req, res) => {
    res.json(memoryStats());
});

// --------------------------------------------------
// Temporary allocation
//
// Example:
// /allocate?mb=100
//
// The objects are NOT intentionally retained after
// the request finishes.
// --------------------------------------------------

app.get("/allocate", (req, res) => {
    const mb = Number(req.query.mb || 10);

    if (!Number.isFinite(mb) || mb <= 0 || mb > 500) {
        return res.status(400).json({
            error: "mb must be between 1 and 500"
        });
    }

    const bytesPerObject = 1024;
    const count = Math.floor((mb * 1024 * 1024) / bytesPerObject);

    console.log(
        `[ALLOCATE] Creating approximately ${mb} MB of temporary objects`
    );

    temporaryObjects = allocateObjects(count, bytesPerObject);

    const result = {
        operation: "temporary allocation",
        requestedMB: mb,
        objectCount: temporaryObjects.length,
        message:
            "Objects are temporary and may be garbage collected."
    };

    // Remove the references.
    temporaryObjects = [];

    res.json({
        ...result,
        memory: memoryStats()
    });
});

// --------------------------------------------------
// Intentional memory leak
//
// Example:
// /leak?mb=50
//
// Objects are pushed into leakedObjects and therefore
// remain reachable.
// --------------------------------------------------

app.get("/leak", (req, res) => {
    const mb = Number(req.query.mb || 10);

    if (!Number.isFinite(mb) || mb <= 0 || mb > 500) {
        return res.status(400).json({
            error: "mb must be between 1 and 500"
        });
    }

    const bytesPerObject = 1024;
    const count = Math.floor((mb * 1024 * 1024) / bytesPerObject);

    console.log(
        `[LEAK] Retaining approximately ${mb} MB of objects`
    );

    const objects = allocateObjects(count, bytesPerObject);

    leakedObjects.push(...objects);

    res.json({
        operation: "intentional leak",
        requestedMB: mb,
        objectsAdded: objects.length,
        totalLeakedObjects: leakedObjects.length,
        message:
            "Objects remain referenced and cannot be garbage collected.",
        memory: memoryStats()
    });
});

// --------------------------------------------------
// Release leaked objects
// --------------------------------------------------

app.get("/release", (req, res) => {
    const previousCount = leakedObjects.length;

    leakedObjects.length = 0;

    res.json({
        operation: "release",
        releasedObjects: previousCount,
        message:
            "References have been removed. GC can reclaim the objects.",
        memory: memoryStats()
    });
});

// --------------------------------------------------
// Manual GC
//
// Requires:
// node --expose-gc server.js
// --------------------------------------------------

app.get("/gc", (req, res) => {
    if (typeof global.gc !== "function") {
        return res.status(500).json({
            error: "GC is not exposed",
            message:
                "Start Node.js with --expose-gc"
        });
    }

    const before = memoryStats();

    console.log("[GC] Manual garbage collection requested");

    global.gc();

    const after = memoryStats();

    res.json({
        operation: "manual garbage collection",
        before,
        after
    });
});

// --------------------------------------------------
// Heap snapshot
// --------------------------------------------------

app.post("/snapshot", (req, res) => {
    try {
        const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-");

        const filename = `heap-${timestamp}-${process.pid}.heapsnapshot`;

        const filepath = path.join(
            SNAPSHOT_DIR,
            filename
        );

        console.log(
            `[SNAPSHOT] Writing heap snapshot: ${filepath}`
        );

        const snapshotPath =
            v8.writeHeapSnapshot(filepath);

        console.log(
            `[SNAPSHOT] Completed: ${snapshotPath}`
        );

        res.json({
            success: true,
            file: snapshotPath,
            sizeBytes: fs.statSync(snapshotPath).size,
            memory: memoryStats()
        });
    } catch (err) {
        console.error(
            "[SNAPSHOT] Failed:",
            err
        );

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// --------------------------------------------------
// List snapshots
// --------------------------------------------------

app.get("/snapshots", (req, res) => {
    try {
        const files = fs
            .readdirSync(SNAPSHOT_DIR)
            .filter(file =>
                file.endsWith(".heapsnapshot")
            )
            .map(file => {
                const filepath =
                    path.join(SNAPSHOT_DIR, file);

                const stat =
                    fs.statSync(filepath);

                return {
                    file,
                    sizeMB: (
                        stat.size /
                        1024 /
                        1024
                    ).toFixed(2),
                    createdAt: stat.birthtime
                };
            });

        res.json({
            directory: SNAPSHOT_DIR,
            count: files.length,
            snapshots: files
        });
    } catch (err) {
        res.status(500).json({
            error: err.message
        });
    }
});

// --------------------------------------------------
// Graceful shutdown
// --------------------------------------------------

function shutdown(signal) {
    console.log(
        `${signal} received. Shutting down...`
    );

    process.exit(0);
}

process.on("SIGTERM", () =>
    shutdown("SIGTERM")
);

process.on("SIGINT", () =>
    shutdown("SIGINT")
);

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `Heap demo application listening on port ${PORT}`
    );

    console.log(
        `Node.js version: ${process.version}`
    );

    console.log(
        `Snapshot directory: ${SNAPSHOT_DIR}`
    );

    console.log(
        `PID: ${process.pid}`
    );

    console.log(
        "Initial memory:",
        memoryStats()
    );
});
