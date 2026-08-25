# Kubernetes Node.js Heap Memory Lab

A hands-on Kubernetes lab for understanding Node.js heap memory, garbage
collection, memory leaks, heap snapshots, and Kubernetes OOMKilled behavior.

## Architecture

```text
                    Managed Kubernetes
                           |
                           |
                    NodePort Service
                           |
                           v
                    ┌──────────────┐
                    │   Node.js    │
                    │  Heap Demo   │
                    │              │
                    │   :3000      │
                    └──────────────┘
