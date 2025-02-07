module.exports = class CustomError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.status =
      String(statusCode).startsWith("4") || String(statusCode).startsWith("3")
        ? "error"
        : "fail";

    // this -> gives error.stack property
    // this.constructor -> makes sure error stack trace wont involve CustomError class but training starts where the error itself occur eg error at /Users/user/Desktop/USER_RES_ORDER_PRODS_CARTS/middlewares/send_email_token.js
    // instead of starting from /Users/user/Desktop/USER_RES_ORDER_PRODS_CARTS/utils/CustomError.js
    Error.captureStackTrace(this, this.constructor);
  }
};
