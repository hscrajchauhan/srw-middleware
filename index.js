
const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const SITES_CONFIG = process.env.SITES_CONFIG || 'sources.json';

app.get('/check-jobs', (req, res) => {
    try {
        const sitesData = fs.readFileSync(SITES_CONFIG, 'utf8');
        res.json({status: "success", data: JSON.parse(sitesData)});
    } catch (err) {
        res.json({status: "error", message: err.message});
    }
});

app.listen(PORT, () => console.log(`Middleware running on port ${PORT}`));
