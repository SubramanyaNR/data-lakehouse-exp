#!/bin/bash

# ArgoCD Port Forward Script
# Runs in background and auto-reconnects

PORT=${1:-8080}
NAMESPACE="argocd"
SERVICE="svc/argocd-server"

# Kill any existing port-forward on this port
pkill -f "port-forward.*$PORT:443" 2>/dev/null

echo "=========================================="
echo "  ArgoCD UI Port Forward"
echo "=========================================="
echo "  URL:      https://localhost:$PORT"
echo "  Username: admin"
echo "  Password: $(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d)"
echo "=========================================="
echo ""
echo "Starting port-forward (runs in background)..."
echo "To stop: run 'pkill -f port-forward.*argocd'"
echo ""

# Run port-forward in a loop (auto-reconnect if it drops)
while true; do
    kubectl port-forward $SERVICE -n $NAMESPACE $PORT:443 --address 0.0.0.0 2>/dev/null
    echo "Connection dropped. Reconnecting in 3 seconds..."
    sleep 3
done
