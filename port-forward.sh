##!/bin/bash
# Port Forward Script for ArgoCD, Prometheus, and Grafana
# Runs in background and auto-reconnects

ARGOCD_PORT=${1:-8080}
GRAFANA_PORT=${2:-3000}
PROMETHEUS_PORT=${3:-9090}

# Kill any existing port-forwards
pkill -f "port-forward.*argocd-server" 2>/dev/null
pkill -f "port-forward.*grafana" 2>/dev/null
pkill -f "port-forward.*prometheus" 2>/dev/null

echo "=========================================="
echo "  Port Forward - All Services"
echo "=========================================="
echo ""
echo "  ArgoCD:"
echo "    URL:      https://localhost:$ARGOCD_PORT"
echo "    Username: admin"
echo "    Password: $(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" 2>/dev/null | base64 -d)"
echo ""
echo "  Grafana:"
echo "    URL:      http://localhost:$GRAFANA_PORT"
echo "    Username: admin"
echo "    Password: $(kubectl get secret -n monitoring kube-prometheus-stack-grafana -o jsonpath="{.data.admin-password}" 2>/dev/null | base64 -d)"
echo ""
echo "  Prometheus:"
echo "    URL:      http://localhost:$PROMETHEUS_PORT"
echo ""
echo "=========================================="
echo ""
echo "To stop all: pkill -f port-forward"
echo ""

# Start all port-forwards in background
while true; do
    kubectl port-forward svc/argocd-server -n argocd $ARGOCD_PORT:443 --address 0.0.0.0 2>/dev/null &
    kubectl port-forward svc/kube-prometheus-stack-grafana -n monitoring $GRAFANA_PORT:80 --address 0.0.0.0 2>/dev/null &
    kubectl port-forward svc/kube-prometheus-stack-prometheus -n monitoring $PROMETHEUS_PORT:9090 --address 0.0.0.0 2>/dev/null &
    
    sleep 30
    
    # Check and restart if any died
    pgrep -f "port-forward.*argocd-server" > /dev/null || echo "[ArgoCD] Reconnecting..."
    pgrep -f "port-forward.*grafana" > /dev/null || echo "[Grafana] Reconnecting..."
    pgrep -f "port-forward.*prometheus" > /dev/null || echo "[Prometheus] Reconnecting..."
done
