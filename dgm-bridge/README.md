# DGM Bridge Remote v1

DGM Bridge is an Android host/client application for authorized remote Internet sharing.

The current Android module establishes the Android VPN boundary and device identity. A VPN interface by itself does not forward Internet traffic. The encrypted transport, remote host forwarding, pairing service, relay fallback, host pool, and automatic failover are separate components and must be implemented before this is advertised as a working remote Internet-sharing service.

The system must not be used to bypass carrier billing, data limits, authentication, or network restrictions.

Planned transport:
1. Secure device registration
2. Short-lived QR pairing
3. Host health checks
4. Direct tunnel when possible
5. Relay fallback
6. Host pool and automatic failover
7. Admin-controlled host switching
