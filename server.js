const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: "uploads/",
    filename: (req, file, cb) => {
        crypto.randomBytes(16, (err, buf) => {
            if (err) return cb(err);
            cb(null, buf.toString("hex") + path.extname(file.originalname));
        });
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== "application/pdf") {
            cb(new Error("Only PDF files are allowed"));
            return;
        }
        cb(null, true);
    }
});

const app = express();
app.use(cors());
app.use(express.json());

// Ensure necessary directories exist
async function ensureDirectories() {
    const dirs = ["uploads", "output"];
    for (const dir of dirs) {
        try {
            await fs.access(dir);
        } catch {
            await fs.mkdir(dir);
        }
    }
}

// Function to set PDF DPI using Ghostscript with explicit DPI setting
async function setPdfDPI(inputPath, outputPath, targetDPI) {
    return new Promise((resolve, reject) => {
        // Create a PostScript file to set DPI
        const psFile = path.join("uploads", "setdpi.ps");
        const psContent = `
            << /EndPage {
                2 dict begin
                /pdfmark where {pop} {userdict /pdfmark /cleartomark load put} ifelse
                [
                    /Title (Set DPI)
                    /Author (PDF Processor)
                    /Creator (PDF DPI Setter)
                    /Producer (Ghostscript)
                    /ModDate (D:20240214)
                    /CreationDate (D:20240214)
                    /Subject (DPI Modified PDF)
                    /Keywords (DPI, PDF)
                    /ViewerPreferences <<
                        /DisplayDocTitle true
                        /HideToolbar false
                        /HideMenubar false
                        /HideWindowUI false
                        /FitWindow false
                        /CenterWindow false
                        /ShowPrintDialog true
                    >>
                    /SetDistillerParams <<
                        /AutoRotatePages /None
                        /ColorImageDownsampleType /None
                        /GrayImageDownsampleType /None
                        /MonoImageDownsampleType /None
                        /ColorImageResolution ${targetDPI}
                        /GrayImageResolution ${targetDPI}
                        /MonoImageResolution ${targetDPI}
                        /DownsampleColorImages false
                        /DownsampleGrayImages false
                        /DownsampleMonoImages false
                        /AutoFilterColorImages false
                        /AutoFilterGrayImages false
                        /ColorImageFilter /FlateEncode
                        /GrayImageFilter /FlateEncode
                        /MonoImageFilter /CCITTFaxEncode
                        /ColorConversionStrategy /LeaveColorUnchanged
                        /PreserveOverprintSettings true
                        /UCRandBGInfo /Preserve
                        /ParseDSCComments true
                        /PreserveCopyPage true
                        /CannotEmbedFontPolicy /Warning
                    >>
                    /DOCINFO pdfmark
                } stopped cleartomark
                end
                true
            } bind>> setpagedevice`;

        // Write the PostScript file
        fs.writeFile(psFile, psContent)
            .then(() => {
                // Execute Ghostscript with the PostScript file
                const command = `gs \
                    -sDEVICE=pdfwrite \
                    -dNOPAUSE \
                    -dBATCH \
                    -dQUIET \
                    -dPDFSETTINGS=/prepress \
                    -dCompatibilityLevel=1.4 \
                    -dDEVICEXRESOLUTION=${targetDPI} \
                    -dDEVICEYRESOLUTION=${targetDPI} \
                    -dFIXEDMEDIA \
                    -dPDFX \
                    -dUseCIEColor \
                    -f "${psFile}" \
                    -f "${inputPath}" \
                    -sOutputFile="${outputPath}"`;

                exec(command, async (error, stdout, stderr) => {
                    // Clean up the PostScript file
                    await fs.unlink(psFile).catch(console.error);

                    if (error) {
                        console.error("Ghostscript error:", stderr);
                        reject(new Error(`Failed to set PDF DPI: ${error.message}`));
                    } else {
                        resolve();
                    }
                });
            })
            .catch(error => {
                reject(new Error(`Failed to create PostScript file: ${error.message}`));
            });
    });
}

// Handle file uploads and DPI conversion
app.post("/convert", upload.array("files"), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }

        const targetDPI = parseInt(req.body.dpi) || 300;
        if (targetDPI < 72 || targetDPI > 2400) {
            return res.status(400).json({ error: "DPI must be between 72 and 2400" });
        }

        const results = [];
        for (const file of req.files) {
            const outputFileName = `${crypto.randomBytes(16).toString("hex")}.pdf`;
            const outputPath = path.join("output", outputFileName);

            try {
                await setPdfDPI(file.path, outputPath, targetDPI);
                results.push({
                    originalName: file.originalname,
                    name: outputFileName,
                    url: `/output/${outputFileName}`,
                    dpi: targetDPI
                });
            } catch (error) {
                console.error("Processing error:", error);
                throw error;
            } finally {
                // Clean up uploaded file
                await fs.unlink(file.path).catch(err => console.error("Cleanup error:", err));
            }
        }

        res.status(200).json({
            message: "Files processed successfully",
            files: results
        });

    } catch (error) {
        console.error("Unexpected server error:", error);
        res.status(500).json({
            error: "Internal Server Error",
            details: error.message
        });
    }
});

// Serve processed files
app.get("/output/:filename", async (req, res) => {
    try {
        const filePath = path.join(__dirname, "output", req.params.filename);
        await fs.access(filePath);
        res.download(filePath);
    } catch (error) {
        res.status(404).json({ error: "File not found" });
    }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
    await ensureDirectories();
    console.log(`✅ Server running on http://localhost:${PORT}`);
});