const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const installAviatorApi = require("./aviator-api");
installAviatorApi(app);

const PORT = Number(process.env.PORT || 10000);