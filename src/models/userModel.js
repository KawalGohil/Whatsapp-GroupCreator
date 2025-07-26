const db = require('../../database');
const bcrypt = require('bcrypt');
const saltRounds = 10;

function findUserByUsername(username, callback) {
    const sql = 'SELECT * FROM users WHERE username = ?';
    db.get(sql, [username], (err, user) => {
        callback(err, user);
    });
}

function verifyPassword(password, hash, callback) {
    bcrypt.compare(password, hash, (err, result) => {
        callback(err, result);
    });
}

function createUser(username, password, callback) {
    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) return callback(err);

        const sql = 'INSERT INTO users (username, password) VALUES (?, ?)';
        db.run(sql, [username, hash], function (err) {
            if (err) {
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return callback(new Error('Username already exists'));
                }
                return callback(err);
            }
            callback(null, { id: this.lastID, username });
        });
    });
}

module.exports = {
    findUserByUsername,
    verifyPassword,
    createUser,
};