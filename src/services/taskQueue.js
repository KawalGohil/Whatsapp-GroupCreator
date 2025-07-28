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
        // If we are not already processing, start the process.
        if (!this.isProcessing) {
            this.emit('new_task');
        }
    }

    getNextTask() {
        return this.queue.shift();
    }
}

// Export a single instance to be used across the application
module.exports = new TaskQueue();