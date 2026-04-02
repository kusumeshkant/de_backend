const mongoose = require('mongoose');

const UploadLogSchema = new mongoose.Schema(
  {
    storeId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
    storeName:       { type: String },
    uploadedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedByName:  { type: String, default: 'Unknown' },
    fileName:        { type: String, required: true },
    totalRows:       { type: Number, default: 0 },
    totalColumns:    { type: Number, default: 0 },
    created:         { type: Number, default: 0 },
    updated:         { type: Number, default: 0 },
    skipped:         { type: Number, default: 0 },
    errorCount:      { type: Number, default: 0 },
    errors:          [{ barcode: String, message: String }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('UploadLog', UploadLogSchema);
