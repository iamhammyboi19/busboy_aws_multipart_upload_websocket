# busboy_aws_multipart_upload_websocket
Using busboy to upload to aws s3 multipart server and using socket to send client current progress

This uploads two files a document file and an image file 
The files field names are `"docs_field"` and `"msa_imgs"`
It accept each file sizes in the request header which is `X-Image-Filesize` and `X-Docs-Filesize`
It also accepts X-Client-Id in request header which should be sent to the web socket server on connection
`ws://localhost:3000/?client_id=8928y4yf3y` for example
The web socket is checked from what is in the server to send the client status of the files that are currently uploaded to the server

I get to understand better how aws upload works after using the multipart upload

1. At first I used the normal upload class from the `aws/lib/storage` library but I realised whenever I use `upload.on("httpUploadProgress", ()=>{})` it doesn't show the upload progress for me

2. So I later get to know it uploads in parts which is 5mb per upload then that is when the `"httpUploadProgress"` event gets triggered ie a 6mb uploads will trigger twice first the 5mb and second the 1mb (because that is the last part anyways) with that aws `"httpUploadProgress"` will only get triggered twice which is not useful for my case.

3. So what I did was send the file progress as I read chunks from the file stream (if the file is less than 5mb I use putObjectCommand to upload it at once). I was advised that aws do it 5mb per upload because of latency issue and cost wise. As I read this chunks and buffer it inside an array it happens so fast that most time with 1 second the upload progress is 100% (for files less than 5mb and what I just tell the client is processing the buffered data)

4. For files greater than 5mb I do them in 5mb parts upload which I send the progress on every 5mb buffered chunks. But whenever the 5mb part is uploading using UploadPartCommand. It actually stop buffering the data and tell the client it is processing that specific buffered part number, then it continues when it is done.

> [!NOTE]
> The whole story is I want it to show update on 16kb uploads or 128kb uploads but aws advise people to upload parts in 5mb which means I have to buffer those chunks into a Buffer object then upload it in parts (less 5mb if file size is less than 5mb or 5mb per parts if file is greater than 5mb). The progress I am showing the client is the actual 5mb buffer upload part. It only pauses whenever it reaches every 5mb part upload and await UploadPartCommand is doing its work
