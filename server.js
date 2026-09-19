const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Mock Database (In production, replace with PostgreSQL or MongoDB)
let userState = {
    username: "Demo User",
    email: "user@datamart.com",
    walletBalance: 150.00,
    transactions: [
        { id: "TXN-9842", service: "MTN 5GB Data", amount: 25.00, status: "Successful", date: "2026-09-18 14:30" },
        { id: "TXN-9841", service: "Airtime Topup ($10)", amount: 10.00, status: "Successful", date: "2026-09-17 09:15" }
    ]
};

// API: Get user profile and dashboard data
app.get('/api/user', (req, res) => {
    res.json(userState);
});

// API: Simulate a purchase (Data bundles, airtime, etc.)
app.post('/api/purchase', (req, res) => {
    const { service, amount } = req.body;
    
    if (!service || !amount) {
        return res.status(400).json({ success: false, message: "Invalid service or amount." });
    }

    const numericAmount = parseFloat(amount);

    if (userState.walletBalance < numericAmount) {
        return res.status(400).json({ success: false, message: "Insufficient wallet balance. Please fund your wallet." });
    }

    // Deduct balance and record transaction
    userState.walletBalance -= numericAmount;
    const newTxn = {
        id: `TXN-${Math.floor(1000 + Math.random() * 9000)}`,
        service: service,
        amount: numericAmount,
        status: "Successful",
        date: new Date().toISOString().replace('T', ' ').substring(0, 16)
    };

    userState.transactions.unshift(newTxn);

    res.json({ success: true, message: `Successfully purchased ${service}!`, user: userState });
});

// API: Simulate wallet funding
app.post('/api/fund-wallet', (req, res) => {
    const { amount } = req.body;
    const numericAmount = parseFloat(amount);

    if (!numericAmount || numericAmount <= 0) {
        return res.status(400).json({ success: false, message: "Invalid funding amount." });
    }

    userState.walletBalance += numericAmount;
    userState.transactions.unshift({
        id: `TXN-${Math.floor(1000 + Math.random() * 9000)}`,
        service: "Wallet Funding",
        amount: numericAmount,
        status: "Successful",
        date: new Date().toISOString().replace('T', ' ').substring(0, 16)
    });

    res.json({ success: true, message: `Successfully added $${numericAmount.toFixed(2)} to wallet!`, user: userState });
});

// Health check endpoint for Render deployment
app.get('/api/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
