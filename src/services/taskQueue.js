// src/services/taskQueue.js
const { EventEmitter } = require('events');

class TaskQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.isProcessing = false;
    }

    addTask(task) {
        this.queue.push(task);
        // --- THIS IS THE FIX ---
        // Emit the username so the service knows which user's queue to check
        this.emit('new_task', task.username);
    }

    getNextTask() {
        return this.queue.shift();
    }
}

// Export a single instance to be used across the application
module.exports = new TaskQueue();