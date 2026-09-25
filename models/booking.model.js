const mongoose = require("mongoose");

const bookingDataSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
    },
    teamName: {
      type: String,
      required: [true, "Team name is required"],
    },
    bookings: [
      {
        customerName: {
          type: String,
        },
        date: {
          type: String,
        },
        time: {
          type: String,
        },
        server: {
          type: String,
        },
        entryFee: {
          type: Number,
        },
        winning: {
          type: Number,
        },
        discription: {
          type: String,
        },
        caster: {
          type: String,
        },
        casterCost: {
          type: Number,
        },
        production: {
          type: String,
        },
        productionCost: {
          type: Number,
        },
        paid: {
          type: Boolean,
          default: false, // Default is unpaid
        },
      },
    ],
  },
  { timestamps: true }
);

// Every booking query is scoped by userId
bookingDataSchema.index({ userId: 1 });

const bookingData = mongoose.model("bookingData", bookingDataSchema);

module.exports = bookingData;
