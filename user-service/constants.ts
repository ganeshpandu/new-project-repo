//constants
import { HttpStatus } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';

interface Response<T> {
    status: HttpStatus;
    data: T;
}

class Metadata {
    @ApiPropertyOptional()
    pageNumber?: number;

    @ApiPropertyOptional()
    limit?: number;

    @ApiPropertyOptional()
    totalCount?: number;
}

enum LogType {
    INFO = 'info',
    ERROR = 'error',
}

const CURRENT_DATE = new Date();

const EXPIRES_IN = '1h';

enum Gender {
    FEMALE = 'FEMALE',
    MALE = 'MALE',
    NON_BINARY = 'NON_BINARY',
    OTHER = 'OTHER',
    PREFER_NOT_TO_SAY = 'PREFER_NOT_TO_SAY',
}

enum ActionStatus {
    SUCCESS = 'SUCCESS',
    FAILED = 'FAILED'
}

const DATA_STATUS = {
    ACTIVE: 'A',
    PENDING: 'P',
    INACTIVE: 'I',
    DELETED: 'X',
};
const REC_STATUS = {
    ACTIVE: "A",
    PENDING: "P",
    INACTIVE: "I",
    DELETED: "X",
};

const REC_SEQ = {
    DEFAULT_RECORD: 0,
    FIRST_RECORD: 1,
};

const ACTIVE_CONDITION = {
    recSeq: REC_SEQ.DEFAULT_RECORD,
    recStatus: REC_STATUS.ACTIVE,
    dataStatus: DATA_STATUS.ACTIVE,
};

const ADMIN = 'b87e7c4a-33af-4c62-a8ab-96a2de431c91';

const DB_NAME = 'public';

const TABLE_NAMES = {
    USERS: 'Users',
    LIST_ITEMS: 'ListItems',
    USER_LISTS: 'UserLists',
    USER_LISTS_INTEGRATIONS: 'UserListIntegrations',
}


const RESPONSE_STATUS = {
    TOKEN: 'Token ',
    USER: 'User ',
    USERNAME: 'Username ',
    PHONE_NUMBER: 'Phone Number ',
    EMAIL: 'Email ',
    METHOD: 'Method ',
    SIGNUP: 'Sign Up ',
    SIGNIN: 'Sign In ',
    REFRESH: 'Refresh ',
    LOGOUT: 'Logout ',
    LISTITEMS: 'ListItems ',
    SUCCESSFUL: 'Successful ',
    SUCCESS: {
        CREATE: 'Created successfully',
        UPDATE: 'Updated successfully',
        DELETE: 'Deleted successfully',
        FIND_ALL: 'Fetched All successfully',
        FIND_UNIQUE: 'Fetched successfully',
    },
    ERROR: {
        REQUIRED: 'Required ',
        NOT_FOUND: 'Not Found ',
        ALREADY_EXISTS: 'Already Exists ',
        INVALID: 'Invalid ',
        BAD_REQUEST: 'Bad Request ',
        INTERNAL_SERVER_ERROR: 'Internal Server Error ',
        ERROR_OCCURRED: 'Error Occurred',
        UNAUTHORIZED: 'Unauthorized',
    },
}
enum MethodNames {
    create = 'create',
    update = 'update',
    delete = 'delete',
    findAll = 'findAll',
    findUnique = 'findUnique',
    updateStatus = 'updateStatus',
    verifyUser = 'verifyUser',
    refreshToken = 'refreshToken',
    logout = 'logout',
    getUserSpotifyData = 'getUserSpotifyData',
}

const STATUS = {
    PENDING: 'PENDING',
    CONNECTED: 'CONNECTED',
    DISCONNECTED: 'DISCONNECTED',
}

const DATA_TYPE = {
    STRING: 'string',
    NUMBER: 'number',
    DATE: 'date',
    BOOLEAN: 'boolean',
    JSON: 'json',
    STRING_ARRAY: 'string[]',
}

export { CURRENT_DATE, EXPIRES_IN, DATA_STATUS, REC_STATUS, REC_SEQ, ACTIVE_CONDITION, ADMIN, RESPONSE_STATUS, DB_NAME, TABLE_NAMES, MethodNames, LogType, Response, Metadata, Gender, ActionStatus, STATUS, DATA_TYPE };
