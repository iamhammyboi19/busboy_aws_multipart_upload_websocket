const busboy = require("busboy");
const crypto = require("node:crypto");
const util = require("node:util");
const {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
// const { Upload } = require("@aws-sdk/lib-storage");
const CustomError = require("./CustomError");

const { all_clients_id } = require("./webSocketForUploadProgressUpdate");

/*
this middleware uses aws s3client and upload to handle image and docs format type uploads
and use the websocket to send real time upload progress back to the user 
*/

require("dotenv").config();

//
const { AWS_S3_ACCESS_SECRET_KEY, AWS_S3_ACCESS_KEY, AWS_S3_BUCKETNAME } =
  process.env;

const s3client = new S3Client({
  region: "eu-north-1",
  credentials: {
    accessKeyId: AWS_S3_ACCESS_KEY,
    secretAccessKey: AWS_S3_ACCESS_SECRET_KEY,
  },
});

// this function is using PutObjectCommand for file objects less than 5mb
// the goal is to show upload progress to the user in FE because upload.on(httpUploadProgress) is not working as expected
// this function is using multipartUploadCommands to handle files greater than 5mb
// it is also showing the file upload progress
async function handleMultipartUpload(
  filename,
  fileStream,
  fileSize,
  file_type,
  client_id = null
) {
  // GENERATE FILE NAME
  // the files looks like this supporting_documents/docs_fileSOME_HEX_REGENERATED.pdf
  // or photos/msa_imgsSOME_HEX_GENERATED.jpeg
  const rand = await util.promisify(crypto.randomBytes)(32);
  const rand_buff = rand.toString("hex");
  const filename_type = file_type.startsWith("application")
    ? "docs_file"
    : "msa_imgs";
  const filename_prepend = file_type.startsWith("application")
    ? "supporting_documents/"
    : "photos/";
  const index = filename.lastIndexOf(".");
  const new_filename =
    filename_prepend +
    filename_type +
    rand_buff +
    "." +
    filename.substring(index + 1).toLowerCase();

  // this is needed to send upload progress to the FE
  const PARTSIZE = 5 * 1024 * 1024; // 5mb for multi part uploads
  let uploaded_parts = []; // put multipart uploads details here needed for final upload
  let buffer_parts = []; // put each chunks here till its 5mb and give uploadPartCommand body as buffer
  let uploaded_parts_size = 0; // this is to check if uploaded partsize is up to 5mb then upload buffer that is inside uploaded_parts array
  const PROGRESS_UDPATE_AT_LESS_THAN_FIVE_MB = 16 * 1024; // show 16kb upload progress to the FE
  const PROGRESS_UDPATE_AT_MORE_THAN_FIVE_MB = 128 * 1024; // show 128kb upload progress for files larger than 5mb
  let progress_counter = 0; // this is used to check if the each chunks received for upload is up to 64kb so each 16kb upload progress is sent to FE
  let uploaded_bytes = 0; // this is to check how many bytes has been uploaded to the server
  let part_number = 1; // this is part of the options uploadPartCommand needs for each part parts eg first part might be 5mb second part might be 2mb
  let buffer_less_than_fivemb = [];

  // handle sending upload progress update to the client
  const cur_client_ws = all_clients_id.get(client_id);

  // if filesize is less than 5mb use putObjectCommand to upload at once
  if (fileSize < PARTSIZE) {
    for await (const chunks of fileStream) {
      uploaded_bytes += chunks.length;
      progress_counter += chunks.length;
      buffer_less_than_fivemb.push(chunks);

      //
      if (progress_counter >= PROGRESS_UDPATE_AT_LESS_THAN_FIVE_MB) {
        const cur_progress = Math.round(
          ((uploaded_bytes / fileSize) * 100).toFixed(2)
        );
        if (cur_client_ws) {
          cur_client_ws.send(
            JSON.stringify({
              file_type: filename_type,
              status: "buffering",
              progress: cur_progress,
              message: "Buffering data",
            })
          );
        }
        console.log(`${cur_progress}% for ${filename_type} uploaded`);
        progress_counter = 0;
      }
    }

    const upload_data = Buffer.concat(buffer_less_than_fivemb);

    try {
      // tell the client is it uploading to the server
      if (cur_client_ws) {
        cur_client_ws.send(
          JSON.stringify({
            file_type: filename_type,
            status: "processing",
            progress: 100,
            message: "Processing buffered data",
          })
        );
      }

      await s3client.send(
        new PutObjectCommand({
          Key: new_filename,
          Body: upload_data,
          Bucket: AWS_S3_BUCKETNAME,
          ACL: "public-read",
          ContentType: file_type,
        })
      );
      // send update after file is done uploading
      if (cur_client_ws) {
        cur_client_ws.send(
          JSON.stringify({
            file_type: filename_type,
            status: "completed",
            progress: 100,
            message: "Completed!",
          })
        );
      }
      return new Promise((resolve) => resolve(new_filename));
    } catch (err) {
      console.log("error from PutObjectCommand: ", err);
      const cur_progress = Math.round(
        ((uploaded_bytes / fileSize) * 100).toFixed(2)
      );

      // send error update if something went wrong
      if (cur_client_ws) {
        cur_client_ws.send(
          JSON.stringify({
            file_type: filename_type,
            status: "error",
            progress: cur_progress,
            message: "Error occurred!",
          })
        );
      }

      throw new CustomError(
        "Error occurred while putting file object to server",
        500
      );
    }
  }

  // IF FILESIZE IS GREATER THAN OR EQUAL TO 5MB USE MULTIPART UPLOAD
  if (fileSize >= PARTSIZE) {
    // create the multipart upload command to get upload id

    const created_parts_upload = await s3client.send(
      new CreateMultipartUploadCommand({
        Key: new_filename,
        Bucket: AWS_S3_BUCKETNAME,
        ACL: "public-read",
        ContentType: file_type,
      })
    );

    let upload_id = created_parts_upload.UploadId;

    for await (const chunks of fileStream) {
      uploaded_bytes += chunks.length;
      buffer_parts.push(chunks);
      uploaded_parts_size += chunks.length;
      progress_counter += chunks.length;

      if (progress_counter >= PROGRESS_UDPATE_AT_MORE_THAN_FIVE_MB) {
        const cur_progress = Math.round(
          ((uploaded_bytes / fileSize) * 100).toFixed(2)
        );
        if (cur_client_ws) {
          cur_client_ws.send(
            JSON.stringify({
              file_type: filename_type,
              status: "buffering",
              progress: cur_progress,
              message: "Buffering data",
            })
          );
        }
        console.log(`${cur_progress}% for ${filename_type} uploaded`);
        progress_counter = 0;
      }

      if (uploaded_parts_size >= PARTSIZE) {
        // aws expects full 5mb single buffer
        const each_buffer_part = Buffer.concat(buffer_parts);
        const cur_progress = Math.round(
          ((uploaded_bytes / fileSize) * 100).toFixed(2)
        );

        try {
          if (cur_client_ws) {
            cur_client_ws.send(
              JSON.stringify({
                file_type: filename_type,
                status: "processing",
                progress: cur_progress,
                message: `Processing part ${part_number} buffered data`,
              })
            );
          }
          // upload the 5mb part
          const uploaded_parts_res = await s3client.send(
            new UploadPartCommand({
              UploadId: upload_id,
              Key: new_filename,
              PartNumber: part_number,
              Body: each_buffer_part,
              Bucket: AWS_S3_BUCKETNAME,
              ACL: "public-read",
              ContentType: file_type,
            })
          );

          uploaded_parts.push({
            ETag: uploaded_parts_res.ETag,
            PartNumber: part_number,
          });
        } catch (err) {
          console.log("UploadPartCommand error: ", err);
          const cur_progress = Math.round(
            ((uploaded_bytes / fileSize) * 100).toFixed(2)
          );

          // send error update if something went wrong
          if (cur_client_ws) {
            cur_client_ws.send(
              JSON.stringify({
                file_type: filename_type,
                status: "error",
                progress: cur_progress,
                message: "Error occurred!",
              })
            );
          }
          throw new CustomError(
            "Error occured while uploading part number " + part_number,
            " to server",
            500
          );
        }

        // increase the part number
        // set the buffer_parts to empty array and start accepting other buffer chunks
        // set uploaded_parts_size back to 0
        part_number++;
        buffer_parts = [];
        uploaded_parts_size = 0;
      }
    }

    // in cases where some file size might be 6mb meaning the 5mb is uploaded
    // but the 1mb does not meet this condition (uploaded_parts_size >= PARTSIZE) ie less than 5mb and the file has reached eof
    // check if there any buffer_part inside the array and upload the last buffer chunk
    if (buffer_parts.length > 0) {
      const remaining_buffer_parts = Buffer.concat(buffer_parts);

      try {
        if (cur_client_ws) {
          cur_client_ws.send(
            JSON.stringify({
              file_type: filename_type,
              status: "processing",
              progress: 100,
              message: `Processing final part buffered data`,
            })
          );
        }

        const uploaded_parts_res = await s3client.send(
          new UploadPartCommand({
            UploadId: upload_id,
            Key: new_filename,
            PartNumber: part_number,
            Body: remaining_buffer_parts,
            Bucket: AWS_S3_BUCKETNAME,
            ACL: "public-read",
            ContentType: file_type,
          })
        );

        uploaded_parts.push({
          ETag: uploaded_parts_res.ETag,
          PartNumber: part_number,
        });
      } catch (err) {
        console.log("Final UploadPartCommand error: ", err);

        const cur_progress = Math.round(
          ((uploaded_bytes / fileSize) * 100).toFixed(2)
        );

        // send error update if something went wrong
        if (cur_client_ws) {
          cur_client_ws.send(
            JSON.stringify({
              file_type: filename_type,
              status: "error",
              progress: cur_progress,
              message: "Error occurred!",
            })
          );
        }

        throw new CustomError(
          "Error occurred while uploading final part number to the server",
          500
        );
      }
    }

    // complete the final upload
    try {
      const sorted_parts = uploaded_parts.sort(
        (a, b) => a.PartNumber - b.PartNumber
      );
      await s3client.send(
        new CompleteMultipartUploadCommand({
          Key: new_filename,
          UploadId: upload_id,
          MultipartUpload: { Parts: sorted_parts },
          Bucket: AWS_S3_BUCKETNAME,
          ACL: "public-read",
          ContentType: file_type,
        })
      );

      if (cur_client_ws) {
        cur_client_ws.send(
          JSON.stringify({
            file_type: filename_type,
            status: "completed",
            progress: 100,
            message: `Completed!`,
          })
        );
      }

      return new Promise((resolve) => resolve(new_filename));
    } catch (err) {
      console.log("Error uploading CompleteMultipartUploadCommand: ", err);

      const cur_progress = Math.round(
        ((uploaded_bytes / fileSize) * 100).toFixed(2)
      );

      // send error update if something went wrong
      if (cur_client_ws) {
        cur_client_ws.send(
          JSON.stringify({
            file_type: filename_type,
            status: "error",
            progress: cur_progress,
            message: "Error occurred!",
          })
        );
      }

      throw new CustomError(
        "Error occurred uploading the complete multipart command: ",
        500
      );
    }
  }
}

// reduce the image quality with sharp
// might resize later

// const reduceImageQuality = () => sharp().jpeg({ quality: 85 });

// allows only pdf and docx formats for docs
const SUPPORTED_FORMAT_FOR_DOCS = ["pdf", "docx"];

// JPEG, PNG, WebP, GIF, AVIF, TIFF and SVG
// sharp supported image formats
const SUPPORTED_FORMAT_FOR_IMGS = [
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "tiff",
  "svg",
  "jpg",
];

const ACCEPTED_FILES_NAME_FIELDS = ["docs_field", "msa_imgs"];

//

module.exports = async (req, res, next) => {
  try {
    const bb = busboy({
      headers: req.headers,
      // busboy did not provide a way for user to directly get filesize before using the file stream
      // make sure you check limit for 10mb for the image file in frontend
      limits: { fileSize: 25 * 1024 * 1024 },
    });

    let docs_and_images_upload_promises = [];

    // get form fields and add it to req.body
    bb.on("field", (name, val) => {
      req.body[name] = val;
    });

    // add client_id to the request so that will be used to sort the file upload progress through file socket
    // the client_id will be sent whenever the client connects through frontend
    //   this will add a unique client_id websocket to all_clients_id map
    // use this client_id to find that user so you can send the upload progress
    const cur_client_id = req.get("x-client-id");

    bb.on("file", async (name, file, info) => {
      try {
        const { mimeType } = info;

        if (!ACCEPTED_FILES_NAME_FIELDS.includes(name)) {
          return next(
            new CustomError(name + " is not a valid form field name", 400)
          );
        }

        // check if file reached limit of 25mb for docs
        // 10mb for images (this will be handled in the frontend)
        file.on("limit", () => {
          return next(new CustomError("File cannot be larger than 25mb", 400));
        });

        // check if mimeType is application
        // format pdf, docx
        if (
          mimeType.startsWith("application") ||
          SUPPORTED_FORMAT_FOR_DOCS.includes(mimeType.split("/")[1])
        ) {
          const { filename } = info;
          const docs_file_size = +req.get("x-docs-filesize");
          docs_and_images_upload_promises.push(
            handleMultipartUpload(
              filename,
              file,
              docs_file_size,
              mimeType,
              cur_client_id
            )
              .then((new_docs_file_name) => {
                req.docs_file = new_docs_file_name;
              })
              .catch((err) => {
                console.log("doc file upload error: ", err);
                return next(err);
              })
          );
        } else if (
          mimeType.startsWith("image") ||
          SUPPORTED_FORMAT_FOR_IMGS.includes(mimeType.split("/")[1])
        ) {
          const { filename } = info;
          const img_file_size = +req.get("x-image-filesize");

          docs_and_images_upload_promises.push(
            handleMultipartUpload(
              filename,
              file,
              img_file_size,
              mimeType,
              cur_client_id
            )
              .then((new_img_filename) => {
                req.msa_imgs_file = new_img_filename;
              })
              .catch((err) => {
                console.log("img file upload error: ", err);
                return next(err);
              })
          );
        } else {
          return next(new CustomError("File format not supported", 400));
        }
      } catch (err) {
        next(err);
      }
    });

    bb.on("finish", () => {
      Promise.all(docs_and_images_upload_promises)
        .then(() => {
          return next();
        })
        .catch((err) => {
          console.log("file finish upload error: ", err);
          return next(
            new CustomError(
              "Error uploading both doc and image to the server",
              400
            )
          );
        });
    });

    req.pipe(bb);
  } catch (err) {
    next(err);
  }
};
