// src/services/taskQueue.js
const { EventEmitter } = require('events');

class TaskQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.isProcessing = false; // Note: isProcessing is now managed per-user in whatsappService
    }

    addTask(task) {
        this.queue.push(task);
        // --- THIS IS THE FIX ---
        // Emit the username along with the event. This tells the whatsappService
        // exactly which user's queue needs to be checked.
        this.emit('new_task', task.username);
    }

    // No longer need getNextTask as the queue is managed directly in whatsappService
}

// Export a single instance to be used across the application
module.exports = new TaskQueue();