#!/bin/bash
export DATABASE_URL="postgres://user:password@host:5432/dbname"
export PORT=8080

echo "🚀 Lancement du serveur sur le port $PORT..."
node server.mjs
